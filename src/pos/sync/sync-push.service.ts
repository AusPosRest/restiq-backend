// Offline sync, push side (restiq-backend#185, docs/SYNC-DESIGN.md §5, §7).
// The hub till sends the sales it already made, in its own seq order. Each op
// goes through the same service method the online endpoint calls (AD-18: one
// order pipeline, one money path), keeping the hub's ids, time and prices.
//
// Rules:
// - idempotent per opId: the AD-7 applied_ops ledger answers a re-sent op;
// - seq must be exactly lastAppliedSeq + 1, a gap defers the rest of the batch;
// - a staff member who lost a permission before the op synced does not undo a
//   sale that already happened (decision S3): applied, and audited;
// - the service refusing an op (not found, conflict, invalid) is a rejection
//   kept in sync_dead_letters for the hub's Sync issues screen.
import { HttpException, Injectable, Logger } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import type { Prisma } from '../../generated/prisma/client'
import { DevicePrincipal, PosPrincipal, RegionRegistryService, roleHasPermission } from '../../platform'
import type { Permission } from '../../platform'
import { BillsService } from '../bills/bills.service'
import { OrderLinesService } from '../orders/order-lines.service'
import { OrdersService } from '../orders/orders.service'
import { UpdateOrderLineDto, UpdateOrderStatusDto } from '../orders/orders.dtos'
import { setTenantContext } from '../tenant-context'
import {
  SyncBillCreatePayload,
  SyncBillFinalizePayload,
  SyncLineAddPayload,
  SyncLineRefPayload,
  SyncOpDto,
  SyncOpResult,
  SyncOrderCreatePayload,
  SyncOrderRefPayload,
} from './sync.dtos'

type Tx = Prisma.TransactionClient

// The online endpoint's @RequirePermission for each op type.
const OP_PERMISSION: Readonly<Record<string, Permission>> = {
  'order.create': 'take_orders',
  'order.line.add': 'take_orders',
  'order.line.update': 'take_orders',
  'order.line.remove': 'take_orders',
  'order.status': 'fire_kitchen',
  'bill.create': 'take_orders',
  'bill.finalize': 'settle_bills',
}

/** An op the server refuses; becomes a rejected result and a dead letter. */
class Rejection extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

async function parse<T extends object>(cls: new () => T, payload: Record<string, unknown>): Promise<T> {
  const value = plainToInstance(cls, payload)
  const errors = await validate(value, { whitelist: true })
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ') || 'invalid'}`).join('; ')
    throw new Rejection('invalid_payload', detail)
  }
  return value
}

function minor(value: string): bigint {
  return BigInt(value)
}

@Injectable()
export class SyncPushService {
  private readonly logger = new Logger(SyncPushService.name)
  // ponytail: one push at a time per device in this process; the seq CAS below
  // still guards two API machines. Move to a per-device advisory lock if a hub
  // ever has two pushes in flight across machines often enough to matter.
  private readonly inFlight = new Map<string, Promise<unknown>>()

  constructor(
    private readonly registry: RegionRegistryService,
    private readonly orders: OrdersService,
    private readonly orderLines: OrderLinesService,
    private readonly bills: BillsService,
  ) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  push(device: DevicePrincipal, batchId: string, ops: SyncOpDto[]): Promise<SyncOpResult[]> {
    const previous = this.inFlight.get(device.deviceId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.pushInOrder(device, batchId, ops))
    this.inFlight.set(device.deviceId, run)
    return run.finally(() => {
      if (this.inFlight.get(device.deviceId) === run) this.inFlight.delete(device.deviceId)
    })
  }

  private async pushInOrder(device: DevicePrincipal, batchId: string, ops: SyncOpDto[]): Promise<SyncOpResult[]> {
    const results: SyncOpResult[] = []
    let deferRest = false
    for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
      if (deferRest) {
        results.push({ opId: op.opId, status: 'deferred', code: 'seq_gap' })
        continue
      }
      const result = await this.pushOne(device, batchId, op)
      if (result.status === 'deferred') deferRest = true
      results.push(result)
    }
    await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, device.tenantId)
      await tx.device.update({ where: { id: device.deviceId }, data: { lastSyncAt: new Date() } })
    })
    return results
  }

  private async pushOne(device: DevicePrincipal, batchId: string, op: SyncOpDto): Promise<SyncOpResult> {
    const plane = this.plane()
    const ledger = await plane.appliedOp.findUnique({ where: { opId: op.opId } })
    if (ledger) {
      if (ledger.deviceId !== device.deviceId) {
        return { opId: op.opId, status: 'rejected', code: 'op_id_conflict', message: 'This opId was already used by another device' }
      }
      return { opId: op.opId, status: 'duplicate', ...(ledger.code && { code: ledger.code }) }
    }

    const lastAppliedSeq = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, device.tenantId)
      return (await tx.device.findUniqueOrThrow({ where: { id: device.deviceId }, select: { lastAppliedSeq: true } })).lastAppliedSeq
    })
    if (op.seq > lastAppliedSeq + 1) return { opId: op.opId, status: 'deferred', code: 'seq_gap' }
    if (op.seq <= lastAppliedSeq) {
      return { opId: op.opId, status: 'rejected', code: 'seq_replayed', message: `seq ${op.seq} was already used by another op` }
    }

    let outcome: SyncOpResult
    try {
      await this.apply(device, op)
      outcome = { opId: op.opId, status: 'accepted' }
    } catch (error) {
      const rejection = this.asRejection(error)
      if (!rejection) throw error
      outcome = { opId: op.opId, status: 'rejected', code: rejection.code, message: rejection.message }
    }

    try {
      await this.record(device, batchId, op, outcome)
    } catch (error) {
      if (error instanceof Rejection && error.code === 'seq_race') return { opId: op.opId, status: 'deferred', code: 'seq_race' }
      throw error
    }
    return outcome
  }

  private async record(device: DevicePrincipal, batchId: string, op: SyncOpDto, outcome: SyncOpResult): Promise<void> {
    await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, device.tenantId)
      // CAS on the seq: a second push for the same device that got here first
      // means this op lost the race - nothing is recorded twice.
      const moved = await tx.device.updateMany({ where: { id: device.deviceId, lastAppliedSeq: op.seq - 1 }, data: { lastAppliedSeq: op.seq } })
      if (moved.count === 0) throw new Rejection('seq_race', 'Another push for this device advanced the sequence')
      await tx.appliedOp.create({ data: { opId: op.opId, deviceId: device.deviceId, seq: op.seq, status: outcome.status, code: outcome.code ?? null } })
      if (outcome.status === 'rejected') {
        await tx.syncDeadLetter.create({
          data: {
            tenantId: device.tenantId,
            deviceId: device.deviceId,
            opId: op.opId,
            reasonCode: outcome.code ?? 'rejected',
            reasonText: outcome.message ?? 'Rejected',
            // Metadata only, never the payload (NFR-15).
            payloadMeta: { type: op.type, seq: op.seq, batchId },
          },
        })
      }
    })
  }

  private asRejection(error: unknown): Rejection | null {
    if (error instanceof Rejection) return error
    if (error instanceof HttpException && error.getStatus() < 500) {
      const body = error.getResponse()
      const code = typeof body === 'object' && body !== null && 'code' in body ? String((body).code) : 'rejected'
      const message = typeof body === 'object' && body !== null && 'message' in body ? String((body).message) : error.message
      return new Rejection(code, message)
    }
    return null
  }

  private async staffFor(device: DevicePrincipal, op: SyncOpDto): Promise<PosPrincipal> {
    const staff = await this.plane().$transaction(async (tx: Tx) => {
      await setTenantContext(tx, device.tenantId)
      return tx.staffUser.findFirst({ where: { id: op.actorStaffId, tenantId: device.tenantId }, select: { name: true, role: { select: { name: true } } } })
    })
    if (!staff) throw new Rejection('unknown_staff', 'No such staff member at this restaurant')

    const permission = OP_PERMISSION[op.type]
    if (permission && !roleHasPermission(staff.role.name, permission)) {
      // Decision S3: the sale already happened on the till, so it is kept; the
      // owner sees it in the audit log instead.
      await this.plane().$transaction(async (tx: Tx) => {
        await setTenantContext(tx, device.tenantId)
        await tx.auditEvent.create({
          data: { tenantId: device.tenantId, actorId: op.actorStaffId, actorEmail: staff.name, action: 'sync.permission_lapsed', reason: `${op.type} ${op.opId} needs ${permission}`, occurredAt: new Date(op.at) },
        })
      })
    }
    return { id: op.actorStaffId, tenantId: device.tenantId, outletId: device.outletId, name: staff.name, role: staff.role.name }
  }

  private async apply(device: DevicePrincipal, op: SyncOpDto): Promise<void> {
    if (!(op.type in OP_PERMISSION)) throw new Rejection('unsupported_op', `Operation type ${op.type} is not supported`)
    const staff = await this.staffFor(device, op)
    const at = new Date(op.at)

    switch (op.type) {
      case 'order.create': {
        const p = await parse(SyncOrderCreatePayload, op.payload)
        if (p.tableId) {
          await this.orders.openOrClaimTable(staff, device.outletId, p.tableId, { id: p.orderId, at })
          return
        }
        if (p.tokenNumber === undefined) throw new Rejection('invalid_payload', 'A counter order needs the tokenNumber the hub issued')
        await this.ignoreRepeat(() => this.orders.createCounterOrder(staff, device.outletId, { id: p.orderId, at, tokenNumber: p.tokenNumber as number }))
        return
      }
      case 'order.line.add': {
        const p = await parse(SyncLineAddPayload, op.payload)
        const modifierPrices = p.modifierPriceMinor ?? {}
        for (const id of p.modifierIds ?? []) {
          const price = modifierPrices[id]
          if (typeof price !== 'string' || !/^\d{1,15}$/.test(price)) {
            throw new Rejection('invalid_payload', `modifierPriceMinor is missing a price for modifier ${id}`)
          }
        }
        const replay = {
          id: p.lineId,
          at,
          unitPriceMinor: minor(p.unitPriceMinor),
          modifierPriceMinor: Object.fromEntries((p.modifierIds ?? []).map((id) => [id, minor(modifierPrices[id])])),
        }
        const dto = { itemId: p.itemId, variantId: p.variantId, quantity: p.quantity, modifierIds: p.modifierIds, seatNumber: p.seatNumber }
        await this.ignoreRepeat(() => this.orderLines.addLine(staff, p.orderId, dto, replay))
        return
      }
      case 'order.line.update': {
        const ref = await parse(SyncLineRefPayload, op.payload)
        const dto = await parse(UpdateOrderLineDto, op.payload)
        await this.orderLines.updateLine(staff, ref.orderId, ref.lineId, dto)
        return
      }
      case 'order.line.remove': {
        const ref = await parse(SyncLineRefPayload, op.payload)
        try {
          await this.orderLines.removeLine(staff, ref.orderId, ref.lineId)
        } catch (error) {
          // Removed by an earlier send of this same op whose ledger write was lost.
          if (!(error instanceof HttpException && error.getStatus() === 404 && (await this.lineGone(device, ref.orderId, ref.lineId)))) throw error
        }
        return
      }
      case 'order.status': {
        const ref = await parse(SyncOrderRefPayload, op.payload)
        const dto = await parse(UpdateOrderStatusDto, op.payload)
        const current = await this.orders.getOrder(staff, ref.orderId)
        if (current.status === dto.status) return // re-send after a lost ledger write
        await this.orders.updateStatus(staff, ref.orderId, dto)
        return
      }
      case 'bill.create': {
        const p = await parse(SyncBillCreatePayload, op.payload)
        await this.bills.createBill(staff, p.orderId, { id: p.billId, at })
        return
      }
      case 'bill.finalize': {
        const p = await parse(SyncBillFinalizePayload, op.payload)
        if (p.tenderIds.length !== p.tenders.length) throw new Rejection('invalid_payload', 'tenderIds must have one id per tender')
        const dto = { discountMinor: p.discountMinor, discountReason: p.discountReason, tenders: p.tenders }
        try {
          await this.bills.finalize(staff, p.billId, dto, { tenderIds: p.tenderIds, at })
        } catch (error) {
          if (error instanceof HttpException && this.asRejection(error)?.code === 'already_finalized') return
          throw error
        }
        return
      }
    }
  }

  // A create re-sent after its ledger write was lost hits the hub's own id.
  private async ignoreRepeat(create: () => Promise<unknown>): Promise<void> {
    try {
      await create()
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      this.logger.log('Replayed create already applied; treating as accepted')
    }
  }

  private async lineGone(device: DevicePrincipal, orderId: string, lineId: string): Promise<boolean> {
    return this.plane().$transaction(async (tx: Tx) => {
      await setTenantContext(tx, device.tenantId)
      const order = await tx.order.count({ where: { id: orderId, tenantId: device.tenantId } })
      const line = await tx.orderLine.count({ where: { id: lineId } })
      return order === 1 && line === 0
    })
  }
}
