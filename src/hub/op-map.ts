// Hub mode (#300, HUB-BUILD-PLAN H3): which sync op each allowlisted hub write
// becomes, built from the request plus the handler's response (for the ids
// the hub generated and the prices it charged), so SyncPushService replays the
// exact same sale in the cloud. Every non-GET route in allowlist.ts is here
// (op-recorder.spec.ts checks): an op builder, 'local' (no op - nothing the
// cloud needs) or 'unsupported' (409 offline_unsupported, refused before the
// handler runs). PINs never travel: payloads are built field by field.
import type { TicketView } from '../kitchen/tickets.dtos'
import type { PosPrincipal } from '../platform'
import type { PosLoginResult, ClockEventView } from '../pos/auth/auth.dtos'
import type { BillView, FinalizeBillDto } from '../pos/bills/bills.dtos'
import type { AddComboLineDto, OrderLineView, OrderView, TransferOrderDto, UpdateOrderLineDto, UpdateOrderStatusDto, VoidOrderLineDto } from '../pos/orders/orders.dtos'
import type { CloseShiftDto, LogCashMovementDto, OpenShiftDto } from '../pos/shifts/shifts.dtos'
import type { ShiftView } from '../pos/shifts/shifts.service'

export interface OpInput {
  body: unknown
  params: Record<string, string>
  result: unknown
  /** Set by PosAuthGuard; absent on the login routes. */
  staff?: PosPrincipal
  /** When the handler started - also the op's `at`. */
  startedAt: Date
  /** A read as PGlite's superuser, for what neither request nor response carries (who approved a void, the login clock-in). */
  query: <T>(sql: string, params: unknown[]) => Promise<T[]>
}

export interface BuiltOp {
  type: string
  actorStaffId: string
  payload: Record<string, unknown>
}

type Builder = (input: OpInput) => BuiltOp | null | Promise<BuiltOp | null>
export type OpMapping = Builder | 'local' | 'unsupported'

function actor(input: OpInput): string {
  if (!input.staff) throw new Error('No staff on a guarded hub write')
  return input.staff.id
}

/** Created by this request (not an existing row the route handed back). */
function isNew(row: { createdAt: string }, input: OpInput): boolean {
  return new Date(row.createdAt) >= input.startedAt
}

function modifierPrices(line: OrderLineView): Record<string, string> {
  return Object.fromEntries(line.modifiers.map((m) => [m.modifierId, String(m.priceMinor)]))
}

function op(input: OpInput, type: string, payload: Record<string, unknown>): BuiltOp {
  // undefined keys dropped, so an absent optional field never reaches the cloud as null.
  return { type, actorStaffId: actor(input), payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown> }
}

function newLine(input: OpInput, match: (line: OrderLineView) => boolean): OrderLineView {
  const line = (input.result as OrderView).lines.find((l) => match(l) && isNew(l, input))
  if (!line) throw new Error('The new line is not in the response')
  return line
}

/** The login clock-in (recordClockInIfNeeded), if this login wrote one. */
async function loginClockIn(input: OpInput): Promise<BuiltOp | null> {
  const result = input.result as PosLoginResult
  if (result.status !== 'authenticated') return null
  const [row] = await input.query<{ id: string }>(`SELECT id FROM clock_events WHERE staff_id = $1 AND type = 'clock_in' AND occurred_at >= $2`, [
    result.staff.id,
    input.startedAt,
  ])
  return row ? { type: 'clock.in', actorStaffId: result.staff.id, payload: { clockEventId: row.id } } : null
}

const order = (input: OpInput): OrderView => input.result as OrderView

export const OP_MAP: Readonly<Record<string, OpMapping>> = {
  'POST /pos/v1/auth/login': loginClockIn,
  'POST /pos/v1/auth/select-outlet': loginClockIn,
  'POST /pos/v1/auth/logout': 'local',

  'POST /pos/v1/outlets/:o/tables/:t/order': (input) =>
    isNew(order(input), input) ? op(input, 'order.create', { orderId: order(input).id, tableId: order(input).tableId }) : null,
  'POST /pos/v1/outlets/:o/counter-orders': (input) => op(input, 'order.create', { orderId: order(input).id, tokenNumber: order(input).tokenNumber }),
  'POST /pos/v1/orders/:id/lines': (input) => {
    const line = newLine(input, (l) => !l.comboId && !l.parentLineId)
    return op(input, 'order.line.add', {
      orderId: line.orderId,
      lineId: line.id,
      itemId: line.itemId,
      variantId: line.variantId ?? undefined,
      quantity: line.quantity,
      modifierIds: line.modifiers.length ? line.modifiers.map((m) => m.modifierId) : undefined,
      seatNumber: line.seatNumber ?? undefined,
      note: line.note ?? undefined,
      unitPriceMinor: String(line.unitPriceMinor),
      modifierPriceMinor: line.modifiers.length ? modifierPrices(line) : undefined,
    })
  },
  'PATCH /pos/v1/orders/:id/lines/:l': (input) => {
    const body = input.body as UpdateOrderLineDto
    const line = order(input).lines.find((l) => l.id === input.params.lineId)
    if (!line) throw new Error('The updated line is not in the response')
    return op(input, 'order.line.update', {
      orderId: input.params.orderId,
      lineId: input.params.lineId,
      quantity: body.quantity,
      modifierIds: body.modifierIds,
      seatNumber: body.seatNumber,
      modifierPriceMinor: body.modifierIds ? modifierPrices(line) : undefined,
    })
  },
  'DELETE /pos/v1/orders/:id/lines/:l': (input) => op(input, 'order.line.remove', { orderId: input.params.orderId, lineId: input.params.lineId }),
  'POST /pos/v1/orders/:id/lines/:l/void': async (input) => {
    // The PIN stays on the hub; only who approved travels (from the approval audit row the void just wrote).
    const [approval] = await input.query<{ approverId: string }>(
      `SELECT approver_id AS "approverId" FROM audit_events WHERE action = 'void_after_fire' AND actor_id = $1 AND occurred_at >= $2 ORDER BY occurred_at DESC LIMIT 1`,
      [actor(input), input.startedAt],
    )
    if (!approval) throw new Error('No void approval recorded')
    return op(input, 'order.line.void', {
      orderId: input.params.orderId,
      lineId: input.params.lineId,
      reason: (input.body as VoidOrderLineDto).reason.trim(),
      approvedByStaffId: approval.approverId,
    })
  },
  'POST /pos/v1/orders/:id/combos': (input) => {
    const body = input.body as AddComboLineDto
    const parent = newLine(input, (l) => l.comboId === body.comboId && !l.parentLineId)
    return op(input, 'order.combo.add', {
      orderId: parent.orderId,
      lineId: parent.id,
      comboId: parent.comboId,
      quantity: parent.quantity,
      unitPriceMinor: String(parent.unitPriceMinor),
      seatNumber: parent.seatNumber ?? undefined,
      children: order(input)
        .lines.filter((l) => l.parentLineId === parent.id)
        .map((child) => ({
          lineId: child.id,
          itemId: child.itemId,
          variantId: child.variantId ?? undefined,
          quantity: child.quantity,
          unitPriceMinor: String(child.unitPriceMinor),
          modifierPriceMinor: child.modifiers.length ? modifierPrices(child) : undefined,
        })),
    })
  },
  'PATCH /pos/v1/orders/:id/status': (input) => op(input, 'order.status', { orderId: input.params.orderId, status: (input.body as UpdateOrderStatusDto).status }),
  'POST /pos/v1/orders/:id/transfer': (input) => {
    const body = input.body as TransferOrderDto
    return op(input, 'order.transfer', { orderId: input.params.orderId, newOwnerStaffId: body.newOwnerStaffId, reason: body.reason })
  },
  'DELETE /pos/v1/orders/:id': (input) => op(input, 'order.discard', { orderId: input.params.orderId }),

  'POST /pos/v1/orders/:id/bill': (input) => {
    const bill = input.result as BillView
    return isNew(bill, input) ? op(input, 'bill.create', { orderId: bill.orderId, billId: bill.id }) : null
  },
  'POST /pos/v1/bills/:id/finalize': (input) => {
    const body = input.body as FinalizeBillDto
    const bill = input.result as BillView
    const tenders = body.tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor, riskAcknowledged: t.riskAcknowledged, reference: t.reference, tenderedMinor: t.tenderedMinor }))
    // Each tender the request named, matched to the row it became.
    const unused = [...bill.tenders]
    const tenderIds = tenders.map((t) => {
      const i = unused.findIndex((row) => row.method === t.method && row.amountMinor === t.amountMinor)
      if (i < 0) throw new Error('A tender is not in the response')
      return unused.splice(i, 1)[0].id
    })
    return op(input, 'bill.finalize', { billId: bill.id, discountMinor: body.discountMinor, discountReason: body.discountReason, tenders, tenderIds })
  },
  'POST /pos/v1/bills/:id/refund': 'unsupported', // cloud-only (decision D-1)
  'POST /pos/v1/bills/:id/print': 'local',
  'POST /pos/v1/print-jobs/:id/printed': 'local',

  'POST /pos/v1/shifts': (input) => {
    const shift = input.result as ShiftView
    return op(input, 'shift.open', { shiftId: shift.id, outletId: shift.outletId, floatMinor: (input.body as OpenShiftDto).floatMinor })
  },
  'POST /pos/v1/shifts/:id/cash-movements': (input) => {
    const body = input.body as LogCashMovementDto
    const movement = (input.result as ShiftView).cashMovements.at(-1)
    if (!movement) throw new Error('The cash movement is not in the response')
    return op(input, 'shift.cash_movement', { shiftId: input.params.id, movementId: movement.id, type: body.type, amountMinor: body.amountMinor, reason: body.reason })
  },
  'POST /pos/v1/shifts/:id/close': (input) => op(input, 'shift.close', { shiftId: input.params.id, countedMinor: (input.body as CloseShiftDto).countedMinor }),
  'POST /pos/v1/clock/out': (input) => op(input, 'clock.out', { clockEventId: (input.result as ClockEventView).id }),
  // ponytail: local - no guest QR sessions are opened on the hub; a cloud-side one closes by its idle TTL.
  'POST /pos/v1/tables/:t/close-session': 'local',
  'POST /pos/v1/devices/:id/heartbeat': 'local',

  'POST /pos/v1/bills/:id/intents': 'unsupported', // card payments need Stripe
  'POST /pos/v1/payment-intents/:id/cancel': 'unsupported',
  'POST /pos/v1/payment-intents/:id/simulate': 'unsupported',

  'POST /kitchen/v1/tickets/:id/bump': (input) => {
    const ticket = input.result as TicketView
    return op(input, 'ticket.bump', { orderId: ticket.orderId, stationId: ticket.stationId })
  },
  'POST /kitchen/v1/tickets/:id/recall': (input) => {
    const ticket = input.result as TicketView
    return op(input, 'ticket.recall', { orderId: ticket.orderId, stationId: ticket.stationId })
  },
  'POST /kitchen/v1/tickets/:id/refire': 'local', // stays on the hub (restiq-backend#297)
  'POST /pos/v1/hub/rejections/:op/acknowledge': 'local', // the hub forwards it to /sync/v1 itself (H6)
}

/** "POST /pos/v1/orders/:orderId/lines" and "POST /pos/v1/orders/:id/lines" are the same route. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path.replace(/:[^/]+/g, ':')}`
}

const BY_KEY = new Map(Object.entries(OP_MAP).map(([route, mapping]) => {
  const [method, path] = route.split(' ')
  return [routeKey(method, path), mapping] as const
}))

/** The mapping for a write route, or undefined for one this file doesn't know (refused - fail closed). */
export function mappingFor(method: string, routePath: string): OpMapping | undefined {
  return BY_KEY.get(routeKey(method, routePath))
}
