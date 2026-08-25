// pos/CAP-2 table map & order ownership (AD-5, AD-6). Reuses the existing
// Floor/DiningTable read paths from tenant-admin/CAP-5's floor-plan module
// instead of a second table model - only Order is new here. Ownership is
// this story's core mechanic: exactly one owning staff member; anyone can
// view an occupied table's order, only the owner can mutate it, and a
// separate transfer action reassigns ownership explicitly (never silently).
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { Order, Prisma } from '../../generated/prisma/client'
import { PosPrincipal, RegionRegistryService } from '../../platform'
import { OrderLineView, OrderView, TableMapEntry, TransferOrderDto, UpdateOrderStatusDto } from './orders.dtos'

export type Tx = Prisma.TransactionClient

// Same one-line-per-module convention as admin/checklist/checklist.service.ts
// and others - not worth a cross-module import for a single set_config call.
async function setTenantContext(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}

// Same shape as admin/menu/menu-errors.ts's isUniqueViolation - duplicated
// per module by existing convention (see ops/tenants.service.ts, admin/menu-
// import.service.ts) rather than a cross-module import for one line.
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

async function loadOutlet(tx: Tx, tenantId: string, outletId: string): Promise<void> {
  const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
  if (!outlet || outlet.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
  }
}

async function loadTableInOutlet(tx: Tx, tenantId: string, outletId: string, tableId: string) {
  const table = await tx.diningTable.findUnique({ where: { id: tableId }, include: { floor: true } })
  if (!table || table.tenantId !== tenantId || table.floor.outletId !== outletId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such table for this outlet' })
  }
  return table
}

export async function loadOrder(tx: Tx, tenantId: string, orderId: string): Promise<Order> {
  const order = await tx.order.findUnique({ where: { id: orderId } })
  if (!order || order.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such order' })
  }
  return order
}

/**
 * Owner-only mutation guard, shared by every order/order-line mutation
 * (pos/CAP-2's core rule, reused as-is by pos/CAP-3's order-line endpoints -
 * not reimplemented per module boundary).
 */
export async function assertOwner(tx: Tx, order: Order, staff: PosPrincipal): Promise<void> {
  if (order.ownerId === staff.id) return
  const owner = await tx.staffUser.findUnique({ where: { id: order.ownerId } })
  const ownerName = owner?.name ?? order.ownerId
  throw new ForbiddenException({
    code: 'not_owner',
    message: `This order is owned by ${ownerName} - use the transfer endpoint to take it over`,
    ownerId: order.ownerId,
  })
}

const ORDER_LINE_INCLUDE = {
  modifiers: { include: { modifier: true } },
} satisfies Prisma.OrderLineInclude

type OrderLineWithModifiers = Prisma.OrderLineGetPayload<{ include: typeof ORDER_LINE_INCLUDE }>

function toOrderLineView(line: OrderLineWithModifiers): OrderLineView {
  return {
    id: line.id,
    orderId: line.orderId,
    itemId: line.itemId,
    variantId: line.variantId,
    quantity: line.quantity,
    unitPriceMinor: Number(line.unitPriceMinor),
    addedByStaffId: line.addedByStaffId,
    createdAt: line.createdAt.toISOString(),
    modifiers: line.modifiers.map((m) => ({ id: m.id, modifierId: m.modifierId, name: m.modifier.name, priceMinor: Number(m.priceMinor) })),
  }
}

/** Builds the full OrderView (base fields + lines) - the shape every order read/mutation endpoint returns. */
export async function buildOrderView(tx: Tx, order: Order): Promise<OrderView> {
  const lines = await tx.orderLine.findMany({ where: { orderId: order.id }, include: ORDER_LINE_INCLUDE, orderBy: { createdAt: 'asc' } })
  return {
    id: order.id,
    tenantId: order.tenantId,
    outletId: order.outletId,
    tableId: order.tableId,
    ownerId: order.ownerId,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    lines: lines.map(toOrderLineView),
  }
}

// open->sent->closed only, forward-only - no OrderLine yet so "sent" just
// marks the order handed to the kitchen; "closed" is a placeholder ahead of
// pos/CAP-7's Bill (finalising a Bill will be what actually closes an order).
const FORWARD_TRANSITIONS: Record<Order['status'], Order['status'][]> = {
  open: ['sent'],
  sent: ['closed'],
  closed: [],
}

@Injectable()
export class OrdersService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async getTableMap(staff: PosPrincipal, outletId: string): Promise<TableMapEntry[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)

      const tables = await tx.diningTable.findMany({
        where: { tenantId: staff.tenantId, floor: { outletId } },
        orderBy: { createdAt: 'asc' },
      })
      // One query for every table's order, not N+1 - status != 'closed'
      // is what "occupied" means for CAP-2 (needs-bill is a later story, see
      // the TODO on TableMapEntry).
      const activeOrders = await tx.order.findMany({
        where: { tenantId: staff.tenantId, outletId, status: { not: 'closed' }, tableId: { not: null } },
      })
      const byTable = new Map(activeOrders.map((o) => [o.tableId as string, o]))

      return tables.map((t) => {
        const order = byTable.get(t.id)
        return {
          tableId: t.id,
          floorId: t.floorId,
          label: t.label,
          seatCapacity: t.seatCapacity,
          status: order ? 'occupied' : 'empty',
          orderId: order?.id ?? null,
          ownerId: order?.ownerId ?? null,
        } satisfies TableMapEntry
      })
    })
  }

  /**
   * Opens a new order on an empty table, owned by the calling staff member,
   * or returns the table's existing order unchanged if one is already
   * open/sent - viewing an occupied table's order is not a takeover.
   */
  async openOrClaimTable(staff: PosPrincipal, outletId: string, tableId: string): Promise<OrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadTableInOutlet(tx, staff.tenantId, outletId, tableId)

      const existing = await tx.order.findFirst({ where: { tenantId: staff.tenantId, tableId, status: { not: 'closed' } } })
      if (existing) return buildOrderView(tx, existing)

      try {
        const created = await tx.order.create({
          data: { tenantId: staff.tenantId, outletId, tableId, ownerId: staff.id, status: 'open' },
        })
        return buildOrderView(tx, created)
      } catch (error) {
        // Backstop for the orders_one_active_per_table partial unique index:
        // the check-then-create above has a race window under concurrent
        // requests for the same table. Re-read once instead of surfacing a
        // raw DB error to the caller.
        if (isUniqueViolation(error)) {
          const raced = await tx.order.findFirst({ where: { tenantId: staff.tenantId, tableId, status: { not: 'closed' } } })
          if (raced) return buildOrderView(tx, raced)
        }
        throw error
      }
    })
  }

  /**
   * pos/CAP-5: every open/sent order outlet-wide, table-tied or counter
   * (tableId null) alike - unlike getTableMap above, which only surfaces
   * orders attached to a table. Viewing this list never requires ownership;
   * taking over one of these orders is done via the existing transfer()
   * action below, not a second mechanism.
   *
   * pos/CAP-3 (issue #52) has since landed: each entry now carries its real
   * lines[] via buildOrderView, same as every other order read/mutation
   * response - no separate item-count/running-total summary was needed on
   * top of that, since the full line detail is already there.
   */
  async listOpenOrders(staff: PosPrincipal, outletId: string): Promise<OrderView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)

      const orders = await tx.order.findMany({
        where: { tenantId: staff.tenantId, outletId, status: { not: 'closed' } },
        orderBy: { createdAt: 'asc' },
      })
      return Promise.all(orders.map((order) => buildOrderView(tx, order)))
    })
  }

  /** Any staff member may view an order - viewing never requires ownership. */
  async getOrder(staff: PosPrincipal, orderId: string): Promise<OrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      return buildOrderView(tx, order)
    })
  }

  /** Owner-only mutation - a non-owner is rejected naming the current owner, per SPEC CAP-2. */
  async updateStatus(staff: PosPrincipal, orderId: string, dto: UpdateOrderStatusDto): Promise<OrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      await assertOwner(tx, order, staff)

      if (!FORWARD_TRANSITIONS[order.status].includes(dto.status)) {
        throw new ConflictException({ code: 'invalid_transition', message: `Cannot move an order from "${order.status}" to "${dto.status}"` })
      }

      const updated = await tx.order.update({ where: { id: orderId }, data: { status: dto.status } })
      return buildOrderView(tx, updated)
    })
  }

  /**
   * Explicit handoff, callable by anyone (not CAP-8-gated - this is a normal
   * shift-change/handoff, not one of the six manager-authorised actions).
   * The old owner cannot mutate the order once this completes.
   */
  async transfer(staff: PosPrincipal, orderId: string, dto: TransferOrderDto): Promise<OrderView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      if (order.status === 'closed') {
        throw new ConflictException({ code: 'conflict', message: 'This order is closed and has no owner to transfer' })
      }

      const newOwner = await tx.staffUser.findUnique({ where: { id: dto.newOwnerStaffId } })
      if (!newOwner || newOwner.tenantId !== staff.tenantId) {
        throw new BadRequestException({ code: 'validation_failed', message: 'No such staff member for this tenant' })
      }

      const updated = await tx.order.update({ where: { id: orderId }, data: { ownerId: dto.newOwnerStaffId } })

      // Nice-to-have per stories.yaml story 3 ("audited the same way as other
      // mutations, reason optional here since it's not one of CAP-8's six
      // gated actions") - AD-6 discipline, generalized to a non-gated action.
      // audit_events.reason is NOT NULL, so a fixed placeholder covers the
      // no-reason-given case rather than making the column nullable.
      await tx.auditEvent.create({
        data: {
          tenantId: staff.tenantId,
          actorId: staff.id,
          actorEmail: staff.name,
          action: 'order.ownership_transferred',
          reason: dto.reason ?? `Ownership handed from staff ${order.ownerId} to staff ${dto.newOwnerStaffId}`,
          occurredAt: new Date(),
        },
      })

      return buildOrderView(tx, updated)
    })
  }
}
