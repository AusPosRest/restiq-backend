// Payments, first slice (issue #130 / epic #129): payment intents for the
// simulated card terminal. A cashier sends an amount to the terminal
// (createIntent), the /pos/terminal device polls its outlet's pending
// intents (listPendingForOutlet) and taps Approve / Decline (simulate), and
// the settle screen polls the intent (getIntent) until it is over. The only
// place a Tender is written for an electronic method is intent-core's
// confirmIntent, inside simulate's transaction (ADR-001).
//
// Provider: `simulated` only. A real provider (epic #129 B2) plugs in where
// this file writes `provider: 'simulated'` / `clientPayload: { simulated:
// true }` and where simulate() is the confirmation trigger - a webhook
// handler (B6) calls the same confirmIntent.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { PosPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { isUniqueViolation, loadBill, refreshOpenBillTotals, toBillView } from '../bills'
import { setTenantContext } from '../tenant-context'
import { linkedPeripheral, queueFor } from '../device-routing'
import { ACTIVE_INTENT_STATUSES, confirmIntent, expireIfDue, failIntent, INTENT_INCLUDE, IntentRow, isIntentActive, toPaymentIntentView } from './intent-core'
import { CreatePaymentIntentDto, PaymentIntentView, SimulateIntentDto } from './intents.dtos'

type Tx = Prisma.TransactionClient

// How long a terminal request stays open before the read path expires it -
// the design's 5 minutes for a UPI QR, reused for the card terminal.
// TODO(epic #129 B8): a per-tenant setting only if a tenant asks.
const INTENT_TTL_MS = 5 * 60_000

async function loadIntent(tx: Tx, tenantId: string, intentId: string): Promise<IntentRow> {
  const intent = await tx.paymentIntent.findUnique({ where: { id: intentId }, include: INTENT_INCLUDE })
  if (!intent || intent.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such payment intent' })
  }
  return intent
}

@Injectable()
export class PaymentIntentsService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  /**
   * POST bills/:id/intents. Owner-unrestricted like finalize (a cashier
   * settling is often not the waiter who owns the order). Idempotent per
   * clientKey; one active intent per bill (409 intent_active, also the
   * partial unique index's answer to a concurrent race); the amount may
   * never exceed what is still due after every tender already on the bill.
   */
  async createIntent(staff: PosPrincipal, billId: string, dto: CreatePaymentIntentDto): Promise<{ view: PaymentIntentView; created: boolean }> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const bill = await refreshOpenBillTotals(tx, await loadBill(tx, staff.tenantId, billId))
      if (bill.status === 'finalized') {
        throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
      }

      const existing = await tx.paymentIntent.findUnique({ where: { tenantId_clientKey: { tenantId: staff.tenantId, clientKey: dto.clientKey } }, include: INTENT_INCLUDE })
      if (existing) {
        if (existing.billId !== billId) {
          throw new ConflictException({ code: 'client_key_reused', message: 'This clientKey was already used for a different bill' })
        }
        return { view: toPaymentIntentView(await expireIfDue(tx, existing)), created: false }
      }

      const tenderedMinor = bill.tenders.reduce((sum, t) => sum + t.amountMinor, 0n)
      const remainingMinor = BigInt(toBillView(bill).totalMinor) - tenderedMinor
      if (BigInt(dto.amountMinor) > remainingMinor) {
        throw new BadRequestException({
          code: 'amount_exceeds_remaining',
          message: `Only ${remainingMinor} is still due on this bill`,
        })
      }

      // A stale active intent no longer blocks - expire it first, then the
      // partial unique index is free for the new one.
      const active = await tx.paymentIntent.findFirst({ where: { billId, shareId: null, status: { in: [...ACTIVE_INTENT_STATUSES] } }, include: INTENT_INCLUDE })
      if (active && isIntentActive(await expireIfDue(tx, active))) {
        throw new ConflictException({ code: 'intent_active', message: `A payment is already waiting on the terminal (${active.id})` })
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: staff.tenantId }, select: { country: true } })
      try {
        const intent = await tx.paymentIntent.create({
          data: {
            id: uuidv7(),
            tenantId: staff.tenantId,
            outletId: bill.outletId,
            billId,
            rail: dto.rail,
            provider: 'simulated',
            amountMinor: BigInt(dto.amountMinor),
            currency: tenant.country === 'AU' ? 'AUD' : 'INR',
            status: 'pending',
            clientKey: dto.clientKey,
            clientPayload: { simulated: true },
            expiresAt: new Date(Date.now() + INTENT_TTL_MS),
            createdByStaffId: staff.id,
            // Issue #134: a POS with a linked terminal charges only there.
            targetDeviceId: await linkedPeripheral(tx, staff.tenantId, dto.deviceId, 'terminal'),
          },
          include: INTENT_INCLUDE,
        })
        return { view: toPaymentIntentView(intent), created: true }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException({ code: 'intent_active', message: 'A payment is already waiting on the terminal' })
        }
        throw error
      }
    })
  }

  /** GET payment-intents/:id - the settle screen's poll; expires lazily. */
  async getIntent(staff: PosPrincipal, intentId: string): Promise<PaymentIntentView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      return toPaymentIntentView(await expireIfDue(tx, await loadIntent(tx, staff.tenantId, intentId)))
    })
  }

  /** POST payment-intents/:id/cancel - idempotent on an already-over intent; refuses to cancel money that moved. */
  async cancelIntent(staff: PosPrincipal, intentId: string): Promise<PaymentIntentView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const intent = await expireIfDue(tx, await loadIntent(tx, staff.tenantId, intentId))
      if (intent.status === 'succeeded') {
        throw new ConflictException({ code: 'already_succeeded', message: 'This payment already went through - refund it instead' })
      }
      if (!isIntentActive(intent)) return toPaymentIntentView(intent)
      await tx.paymentIntent.updateMany({
        where: { id: intent.id, status: { in: [...ACTIVE_INTENT_STATUSES] } },
        data: { status: 'cancelled', failureReason: 'cancelled_by_staff' },
      })
      return toPaymentIntentView(await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id }, include: INTENT_INCLUDE }))
    })
  }

  /** GET outlets/:outletId/payment-intents - the terminal device's poll: this outlet's still-open requests, oldest first. Staff only see their own outlet, like the print spool. */
  async listPendingForOutlet(staff: PosPrincipal, outletId: string, deviceId?: string): Promise<PaymentIntentView[]> {
    if (outletId !== staff.outletId) throw new ForbiddenException({ code: 'outlet_mismatch', message: 'Not your outlet' })
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      // One sweep for the whole outlet rather than expireIfDue per row.
      await tx.paymentIntent.updateMany({
        where: { tenantId: staff.tenantId, outletId, status: { in: [...ACTIVE_INTENT_STATUSES] }, expiresAt: { lte: new Date() } },
        data: { status: 'expired', failureReason: 'timed_out' },
      })
      // Issue #134: a linked terminal drains only its own queue.
      const targetDeviceId = await queueFor(tx, staff.tenantId, deviceId, 'terminal')
      const rows = await tx.paymentIntent.findMany({
        where: { tenantId: staff.tenantId, outletId, status: { in: [...ACTIVE_INTENT_STATUSES] }, targetDeviceId },
        include: INTENT_INCLUDE,
        orderBy: { createdAt: 'asc' },
      })
      return rows.map(toPaymentIntentView)
    })
  }

  /**
   * POST payment-intents/:id/simulate - the simulated provider's webhook
   * (ADR-004). 404 unless the intent's provider is `simulated`. Idempotent
   * on a repeat of the same outcome (a double tap on the terminal); any
   * other move out of a terminal state is 409.
   */
  async simulate(staff: PosPrincipal, intentId: string, dto: SimulateIntentDto): Promise<PaymentIntentView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const intent = await loadIntent(tx, staff.tenantId, intentId)
      if (intent.provider !== 'simulated') {
        throw new NotFoundException({ code: 'not_found', message: 'No such payment intent' })
      }

      if (dto.outcome === 'success') {
        if (intent.status === 'succeeded') return toPaymentIntentView(intent)
        if (intent.status === 'failed' || intent.status === 'cancelled') {
          throw new ConflictException({ code: 'already_terminal', message: `This payment is already ${intent.status}` })
        }
        // pending, created, or expired (ADR-011): money moved, record it.
        return toPaymentIntentView(await confirmIntent(tx, { tenantId: staff.tenantId, intentId: intent.id }))
      }

      const current = await expireIfDue(tx, intent)
      if (current.status === 'failed') return toPaymentIntentView(current)
      if (!isIntentActive(current)) {
        throw new ConflictException({ code: 'already_terminal', message: `This payment is already ${current.status}` })
      }
      return toPaymentIntentView(await failIntent(tx, current.id, 'declined'))
    })
  }
}
