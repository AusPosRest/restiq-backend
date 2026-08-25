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
// pre-finalisation"): a line may be ADDED any time the order isn't closed
// (kitchen can still receive more items on an already-sent order), but may
// only be EDITED (quantity/modifiers) or REMOVED while the order is still
// "open" - once sent, the kitchen may already be acting on that specific
// line, so it is frozen except for outright new additions.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { resolveCurrentPrice } from '../../admin'
import type { Order, PriceChannel, Prisma } from '../../generated/prisma/client'
import { PosPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { AddOrderLineDto, OrderView, UpdateOrderLineDto } from './orders.dtos'
import { assertOwner, buildOrderView, loadOrder, Tx } from './orders.service'

// Fixed for this story: pos/CAP-3 only builds dine-in table orders (Order
// always has a tableId - opened via pos/CAP-2's table map). QSR/counter mode
// (pos/CAP-6, a later story) composes over these same endpoints and picks
// its own channel when it exists; there is no channel column on Order today
// to read instead.
const ORDER_PRICE_CHANNEL: PriceChannel = 'dine_in'

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
  if (!item || item.tenantId !== tenantId) {
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

function assertOrderOpenForEdit(order: Order): void {
  if (order.status !== 'open') {
    throw new ConflictException({ code: 'conflict', message: 'This order has already been sent to the kitchen - its lines can no longer be changed or removed' })
  }
}

async function loadOrderLine(tx: Tx, tenantId: string, orderId: string, lineId: string) {
  const line = await tx.orderLine.findUnique({ where: { id: lineId } })
  if (!line || line.tenantId !== tenantId || line.orderId !== orderId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such order line' })
  }
  return line
}

@Injectable()
export class OrderLinesService {
  constructor(private readonly registry: RegionRegistryService) {}

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
      assertVariantBelongsToItem(item, dto.variantId)
      const modifierIds = dto.modifierIds ?? []
      assertModifierSelectionValid(item, modifierIds)

      const price = await resolveCurrentPrice(tx, {
        tenantId: staff.tenantId,
        itemId: dto.itemId,
        variantId: dto.variantId ?? null,
        channel: ORDER_PRICE_CHANNEL,
        outletId: order.outletId,
      })
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
          addedByStaffId: staff.id,
        },
      })
      for (const modifierId of modifierIds) {
        await tx.orderLineModifier.create({
          data: { tenantId: staff.tenantId, orderLineId: line.id, modifierId, priceMinor: modifierPrices.get(modifierId) ?? 0n },
        })
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
      assertOrderOpenForEdit(order)
      const line = await loadOrderLine(tx, staff.tenantId, orderId, lineId)

      if (dto.quantity !== undefined) {
        await tx.orderLine.update({ where: { id: lineId }, data: { quantity: dto.quantity } })
      }

      if (dto.modifierIds !== undefined) {
        const item = await loadItemForOrderLine(tx, staff.tenantId, line.itemId)
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
      assertOrderOpenForEdit(order)
      await loadOrderLine(tx, staff.tenantId, orderId, lineId)

      await tx.orderLine.delete({ where: { id: lineId } })
      return buildOrderView(tx, order)
    })
  }
}
