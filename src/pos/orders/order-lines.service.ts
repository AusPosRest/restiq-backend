// pos/CAP-3 order lines (AD-14). Extends pos/CAP-2's Order with real lines
// built against the existing menu catalogue (tenant-admin/CAP-4's
// MenuItem/ItemVariant/ModifierGroup/Modifier) - see restiq-backend/src/
// admin/menu for those models' actual, already-shipped contract; nothing
// here duplicates or re-guesses that shape.
//
// Ownership and tenant-context are pos/CAP-2's rules, reused verbatim
// (loadOrder/assertOwner imported from orders.service.ts, setTenantContext
// from the shared pos/tenant-context.ts) rather than reimplemented here.
//
// Mutability window, per stories.yaml story 4 and AD-14 ("Order is mutable
// pre-finalisation"): a line may be ADDED any time the order isn't closed.
// restiq-backend#210 (CU-15): the freeze is per line, not per order - a line
// may be EDITED or REMOVED until it is on a kitchen ticket (items added to an
// already-sent order wait on the till until Send to kitchen fires them, see
// orders.service.ts's updateStatus). Once the kitchen has it, only a
// manager-approved void (voidLine) takes it back.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { assertItemAvailable, resolveComboSelection, resolveCurrentPrice } from '../../admin'
import type { Order, OrderLine, PriceChannel, Prisma } from '../../generated/prisma/client'
import { ManagerAuthService, PosPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { AddComboLineDto, AddOrderLineDto, OrderView, UpdateOrderLineDto, VoidOrderLineDto } from './orders.dtos'
import { assertOwner, buildOrderView, loadOrder, Tx } from './orders.service'

// A table order is dine-in; a counter (token) order has no table and is
// priced on the takeaway channel first (restiq-backend#208, SE-8) - Order
// has no channel column, so the table is what tells them apart. Each channel
// falls back to the item's channel-less price; a counter order whose item is
// priced for dine-in only still rings up at that dine-in price.
function orderPriceChannels(order: Order): PriceChannel[] {
  return order.tableId === null ? ['takeaway', 'dine_in'] : ['dine_in']
}

type ItemForOrderLine = Prisma.MenuItemGetPayload<{
  include: {
    variants: true
    modifierGroups: { include: { group: { include: { modifiers: true } } } }
  }
}>

const ITEM_INCLUDE = {
  variants: true,
  modifierGroups: { include: { group: { include: { modifiers: true } } } },
} satisfies Prisma.MenuItemInclude

async function loadItemForOrderLine(tx: Tx, tenantId: string, itemId: string): Promise<ItemForOrderLine> {
  const item = await tx.menuItem.findUnique({ where: { id: itemId }, include: ITEM_INCLUDE })
  if (!item || item.tenantId !== tenantId || item.archivedAt) {
    throw new BadRequestException({ code: 'validation_failed', message: 'No such menu item' })
  }
  return item
}

function assertVariantBelongsToItem(item: ItemForOrderLine, variantId: string | undefined): void {
  if (variantId === undefined) return
  if (!item.variants.some((v) => v.id === variantId)) {
    throw new BadRequestException({ code: 'validation_failed', message: 'That variant does not belong to this item' })
  }
}

/**
 * Validates a proposed modifier selection against every modifier group
 * attached to the item - not just the groups a submitted modifierId happens
 * to touch. A required group (minSelections > 0) with nothing selected is
 * exactly as much a violation as picking too many from an optional one -
 * CAP-3's success criterion ("a line violating a modifier group's min/max
 * cannot be added") covers both, enforced server-side regardless of what a
 * client already validated on its own.
 */
function assertModifierSelectionValid(item: ItemForOrderLine, modifierIds: string[]): void {
  const validModifierIds = new Set(item.modifierGroups.flatMap((link) => link.group.modifiers.map((m) => m.id)))
  for (const id of modifierIds) {
    if (!validModifierIds.has(id)) {
      throw new BadRequestException({ code: 'validation_failed', message: 'One or more modifiers do not belong to this item' })
    }
  }

  for (const link of item.modifierGroups) {
    const group = link.group
    const selectedCount = group.modifiers.filter((m) => modifierIds.includes(m.id)).length
    if (selectedCount < group.minSelections || selectedCount > group.maxSelections) {
      throw new BadRequestException({
        code: 'modifier_selection_invalid',
        message: `"${group.name}" requires between ${group.minSelections} and ${group.maxSelections} selection(s), got ${selectedCount}`,
      })
    }
  }
}

/** Snapshot of a modifier's current price, keyed by id, for the modifiers actually being attached to a line. */
async function resolveModifierPrices(tx: Tx, tenantId: string, modifierIds: string[]): Promise<Map<string, bigint>> {
  if (modifierIds.length === 0) return new Map()
  const modifiers = await tx.modifier.findMany({ where: { id: { in: modifierIds }, tenantId } })
  return new Map(modifiers.map((m) => [m.id, m.priceMinor]))
}

function assertOrderNotClosed(order: Order): void {
  if (order.status === 'closed') {
    throw new ConflictException({ code: 'conflict', message: 'This order is closed' })
  }
}

/** The line plus (for a combo) its items - a combo is on a ticket once any of its items is. */
async function lineAndChildIds(tx: Tx, line: OrderLine): Promise<string[]> {
  const children = await tx.orderLine.findMany({ where: { parentLineId: line.id }, select: { id: true } })
  return [line.id, ...children.map((c) => c.id)]
}

async function isSentToKitchen(tx: Tx, lineIds: string[]): Promise<boolean> {
  return (await tx.ticketLine.count({ where: { orderLineId: { in: lineIds } } })) > 0
}

async function assertLineNotSent(tx: Tx, line: OrderLine): Promise<void> {
  if (await isSentToKitchen(tx, await lineAndChildIds(tx, line))) {
    throw new ConflictException({ code: 'line_sent', message: 'The kitchen already has this item - ask a manager to void it' })
  }
}

async function loadOrderLine(tx: Tx, tenantId: string, orderId: string, lineId: string) {
  const line = await tx.orderLine.findUnique({ where: { id: lineId } })
  if (!line || line.tenantId !== tenantId || line.orderId !== orderId || line.voidedAt) {
    throw new NotFoundException({ code: 'not_found', message: 'No such order line' })
  }
  return line
}

// restiq-backend#160: a combo is edited by removing it and adding it again -
// its lines are priced as one unit, so a partial edit could leave the combo
// half-changed.
function assertNotComboLine(line: OrderLine, action: 'change' | 'remove'): void {
  if (line.comboId && action === 'change') {
    throw new ConflictException({ code: 'combo_locked', message: 'Remove the combo and add it again to change it' })
  }
  if (line.parentLineId) {
    throw new ConflictException({ code: 'combo_locked', message: `This item is part of a combo - ${action} the whole combo instead` })
  }
}

@Injectable()
export class OrderLinesService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly managerAuth: ManagerAuthService,
  ) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async addLine(staff: PosPrincipal, orderId: string, dto: AddOrderLineDto): Promise<OrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      await assertOwner(tx, order, staff)
      assertOrderNotClosed(order)

      const item = await loadItemForOrderLine(tx, staff.tenantId, dto.itemId)
      await assertItemAvailable(tx, order.outletId, item)
      assertVariantBelongsToItem(item, dto.variantId)
      const modifierIds = dto.modifierIds ?? []
      assertModifierSelectionValid(item, modifierIds)

      let price: Awaited<ReturnType<typeof resolveCurrentPrice>> = null
      for (const channel of orderPriceChannels(order)) {
        price ??= await resolveCurrentPrice(tx, { tenantId: staff.tenantId, itemId: dto.itemId, variantId: dto.variantId ?? null, channel, outletId: order.outletId })
      }
      if (!price) {
        throw new BadRequestException({ code: 'no_price', message: 'No current price is configured for this item' })
      }

      const modifierPrices = await resolveModifierPrices(tx, staff.tenantId, modifierIds)
      const line = await tx.orderLine.create({
        data: {
          tenantId: staff.tenantId,
          orderId,
          itemId: dto.itemId,
          variantId: dto.variantId ?? null,
          quantity: dto.quantity,
          unitPriceMinor: price.priceMinor,
          seatNumber: dto.seatNumber ?? null,
          addedByStaffId: staff.id,
          note: dto.note?.trim() || null,
        },
      })
      for (const modifierId of modifierIds) {
        await tx.orderLineModifier.create({
          data: { tenantId: staff.tenantId, orderLineId: line.id, modifierId, priceMinor: modifierPrices.get(modifierId) ?? 0n },
        })
      }

      // restiq-backend#210 (CU-15): never fired here, even on a sent order -
      // it waits on the till until Send to kitchen (orders.service.ts's
      // updateStatus), so a wrong tap can still be taken back.
      return buildOrderView(tx, order)
    })
  }

  /** restiq-backend#160: adds a combo - a parent line at the combo price plus one child line per chosen item. */
  async addCombo(staff: PosPrincipal, orderId: string, dto: AddComboLineDto): Promise<OrderView> {
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      await assertOwner(tx, order, staff)
      assertOrderNotClosed(order)

      const { combo, children } = await resolveComboSelection(tx, staff.tenantId, order.outletId, dto.comboId, dto.selections)
      const shared = { tenantId: staff.tenantId, orderId, seatNumber: dto.seatNumber ?? null, addedByStaffId: staff.id }
      const parent = await tx.orderLine.create({ data: { ...shared, comboId: combo.id, quantity: dto.quantity, unitPriceMinor: combo.priceMinor } })
      for (const child of children) {
        const line = await tx.orderLine.create({
          data: { ...shared, itemId: child.itemId, variantId: child.variantId, parentLineId: parent.id, quantity: child.quantity * dto.quantity, unitPriceMinor: child.upchargeMinor },
        })
        const modifierPrices = await resolveModifierPrices(tx, staff.tenantId, child.modifierIds)
        for (const modifierId of child.modifierIds) {
          await tx.orderLineModifier.create({ data: { tenantId: staff.tenantId, orderLineId: line.id, modifierId, priceMinor: modifierPrices.get(modifierId) ?? 0n } })
        }
      }
      return buildOrderView(tx, order)
    })
  }

  async updateLine(staff: PosPrincipal, orderId: string, lineId: string, dto: UpdateOrderLineDto): Promise<OrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      await assertOwner(tx, order, staff)
      assertOrderNotClosed(order)
      const line = await loadOrderLine(tx, staff.tenantId, orderId, lineId)
      assertNotComboLine(line, 'change')
      await assertLineNotSent(tx, line)

      if (dto.quantity !== undefined) {
        await tx.orderLine.update({ where: { id: lineId }, data: { quantity: dto.quantity } })
      }

      if (dto.seatNumber !== undefined) {
        await tx.orderLine.update({ where: { id: lineId }, data: { seatNumber: dto.seatNumber } })
      }

      if (dto.modifierIds !== undefined) {
        const item = await loadItemForOrderLine(tx, staff.tenantId, line.itemId!)
        assertModifierSelectionValid(item, dto.modifierIds)
        const modifierPrices = await resolveModifierPrices(tx, staff.tenantId, dto.modifierIds)
        await tx.orderLineModifier.deleteMany({ where: { orderLineId: lineId } })
        for (const modifierId of dto.modifierIds) {
          await tx.orderLineModifier.create({
            data: { tenantId: staff.tenantId, orderLineId: lineId, modifierId, priceMinor: modifierPrices.get(modifierId) ?? 0n },
          })
        }
      }

      return buildOrderView(tx, order)
    })
  }

  async removeLine(staff: PosPrincipal, orderId: string, lineId: string): Promise<OrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      await assertOwner(tx, order, staff)
      assertOrderNotClosed(order)
      const line = await loadOrderLine(tx, staff.tenantId, orderId, lineId)
      assertNotComboLine(line, 'remove')
      await assertLineNotSent(tx, line)

      // A combo's child lines go with it (parent_line_id ON DELETE CASCADE).
      await tx.orderLine.delete({ where: { id: lineId } })
      return buildOrderView(tx, order)
    })
  }

  /**
   * restiq-backend#210 (CU-15): takes back a line the kitchen already has.
   * Manager PIN + reason (ManagerAuthService 'void_after_fire', audited in
   * this same transaction). The line is kept, stamped voided - it drops out
   * of the order, bill and invoice, and its kitchen ticket line shows struck
   * through. A combo is voided whole, items included.
   */
  async voidLine(staff: PosPrincipal, orderId: string, lineId: string, dto: VoidOrderLineDto): Promise<OrderView> {
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      await assertOwner(tx, order, staff)
      assertOrderNotClosed(order)
      const line = await loadOrderLine(tx, staff.tenantId, orderId, lineId)
      if (line.parentLineId) {
        throw new ConflictException({ code: 'combo_locked', message: 'This item is part of a combo - void the whole combo instead' })
      }
      const ids = await lineAndChildIds(tx, line)
      if (!(await isSentToKitchen(tx, ids))) {
        throw new ConflictException({ code: 'line_not_sent', message: 'The kitchen does not have this item yet - just remove it' })
      }

      const approval = await this.managerAuth.authorize('void_after_fire', staff.tenantId, order.outletId, dto.managerPin, dto.reason.trim(), staff.id)
      await tx.orderLine.updateMany({ where: { id: { in: ids } }, data: { voidedAt: new Date(), voidReason: dto.reason.trim() } })
      await tx.ticketLine.updateMany({ where: { orderLineId: { in: ids } }, data: { voided: true } })
      await this.managerAuth.recordApproval(tx, approval, { actorId: staff.id, actorEmail: staff.name, occurredAt: new Date() })
      return buildOrderView(tx, order)
    })
  }
}
