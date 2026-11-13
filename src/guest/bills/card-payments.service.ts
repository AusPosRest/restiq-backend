// #284: real card payments from the guest's phone - a Stripe PaymentIntent created as a
// direct charge on the restaurant's connected account (#282), paid in Stripe's Payment
// Element, then settled server-side by sync (the phone's "I paid") or the Connect webhook.
// Both go through applyStripeIntent -> settle, which writes money only via confirmIntent
// (intent-core's CAS), exactly like the POS terminal and the kiosk.
//
// Stripe calls never run inside a transaction holding the bill lock: plan (short tx) ->
// Stripe -> write (short tx, re-checked under the lock). Refunds live in pos/bills.
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { isUUID } from 'class-validator'
import type Stripe from 'stripe'
import type { Prisma } from '../../generated/prisma/client'
import { isUniqueViolation, loadBill, lockBill, refreshOpenBillTotals, toBillView } from '../../pos/bills'
import { ACTIVE_INTENT_STATUSES, confirmIntent, failIntent, INTENT_INCLUDE, LATE_CAPTURE_REFUND_DUE } from '../../pos/payments'
import type { IntentRow } from '../../pos/payments'
import { GuestPrincipal, RegionRegistryService, StripeService, uuidv7 } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { CardPaymentStartView, GuestBillView, StartCardPaymentDto } from './bills.dtos'
import { assertSessionActive, cardPaymentsFor, GuestBillsService, loadOrderForSession, providerUnavailable } from './bills.service'

type Tx = Prisma.TransactionClient

// While open, an intent blocks staff finalising the bill (commitFinalize's payment_pending) - long
// enough to type a card, short enough not to hold the table. A capture after this still lands (ADR-011).
const CARD_INTENT_TTL_MS = 15 * 60_000
// Statuses whose Stripe PaymentIntent may still take money - superseded ones are cancelled at Stripe first.
const OPEN_STATUSES = ['created', 'pending', 'expired'] as const

/** Platform fee on one payment: round(amount x bps / 10000) + fixed, in minor units. */
export function applicationFeeMinor(amountMinor: bigint, feePercentBps: number, feeFixedMinor: bigint): bigint {
  return (amountMinor * BigInt(feePercentBps) + 5_000n) / 10_000n + feeFixedMinor
}

class PlanChanged extends Error {}

interface Plan {
  tenantId: string
  billId: string
  outletId: string
  shareId: string | null
  amountMinor: bigint
  currency: 'AUD' | 'INR'
  accountId: string
  feeMinor: bigint
  /** An earlier attempt for the same target with the same amount, still active - hand it out again. */
  reuse: IntentRow | null
  /** An earlier attempt for the same target that can no longer be used - cancel it before a new one. */
  stale: IntentRow | null
}

@Injectable()
export class GuestCardPaymentsService {
  private readonly logger = new Logger(GuestCardPaymentsService.name)

  constructor(
    private readonly registry: RegionRegistryService,
    private readonly stripe: StripeService,
    private readonly bills: GuestBillsService,
  ) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  /** POST guest/v1/bills/:id/card-payment */
  async start(guest: GuestPrincipal, billId: string, dto: StartCardPaymentDto, retried = false): Promise<CardPaymentStartView> {
    const plan = await this.plane().$transaction((tx) => this.plan(tx, guest, billId, dto))
    const stripe = this.stripe.client()
    const opts = { stripeAccount: plan.accountId }

    if (plan.reuse?.providerRef) {
      const pi = await stripe.paymentIntents.retrieve(plan.reuse.providerRef, {}, opts)
      if (pi.client_secret) return { intentId: plan.reuse.id, clientSecret: pi.client_secret, amountMinor: Number(plan.amountMinor), currency: plan.currency }
    }
    if (plan.stale) {
      const settledMeanwhile = await this.cancelAtStripe(plan.stale, plan.accountId)
      if (settledMeanwhile) return this.again(guest, billId, dto, retried)
      await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, plan.tenantId)
        await tx.paymentIntent.updateMany({ where: { id: plan.stale?.id, status: { in: [...OPEN_STATUSES] } }, data: { status: 'cancelled', failureReason: 'superseded' } })
      })
    }

    const intentId = uuidv7()
    const pi = await stripe.paymentIntents.create(
      {
        amount: Number(plan.amountMinor),
        currency: plan.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        ...(plan.feeMinor > 0n ? { application_fee_amount: Number(plan.feeMinor) } : {}),
        metadata: { tenantId: plan.tenantId, billId, intentId, ...(dto.guestId ? { guestId: dto.guestId } : {}) },
      },
      { ...opts, idempotencyKey: `restiq-card-payment-${intentId}` },
    )
    try {
      await this.plane().$transaction(async (tx) => {
        // Re-checked under the bill lock: the bill may have moved while Stripe answered.
        const now = await this.plan(tx, guest, billId, dto)
        if (now.reuse || now.stale || now.amountMinor !== plan.amountMinor) throw new PlanChanged()
        await tx.paymentIntent.create({
          data: {
            id: intentId,
            tenantId: plan.tenantId,
            outletId: plan.outletId,
            billId,
            shareId: plan.shareId,
            rail: 'card_online',
            provider: 'stripe',
            amountMinor: plan.amountMinor,
            currency: plan.currency,
            status: 'pending',
            clientKey: `stripe:${pi.id}`,
            providerRef: pi.id,
            clientPayload: { payerPhone: dto.payerPhone ?? null },
            expiresAt: new Date(Date.now() + CARD_INTENT_TTL_MS),
          },
        })
      })
    } catch (error) {
      // Nobody has this PaymentIntent's client secret yet - cancelling is tidiness, not safety.
      await stripe.paymentIntents.cancel(pi.id, {}, opts).catch(() => undefined)
      if (error instanceof PlanChanged || isUniqueViolation(error)) return this.again(guest, billId, dto, retried)
      throw error
    }
    if (!pi.client_secret) throw new Error(`Stripe returned no client secret for ${pi.id}`)
    return { intentId, clientSecret: pi.client_secret, amountMinor: Number(plan.amountMinor), currency: plan.currency }
  }

  private again(guest: GuestPrincipal, billId: string, dto: StartCardPaymentDto, retried: boolean): Promise<CardPaymentStartView> {
    if (retried) throw new ConflictException({ code: 'conflict', message: 'This bill changed while you were paying - try again' })
    return this.start(guest, billId, dto, true)
  }

  /** POST guest/v1/card-payments/:intentId/sync - reads Stripe, never the client. Idempotent. */
  async sync(guest: GuestPrincipal, intentId: string): Promise<GuestBillView> {
    const { providerRef, accountId, billId } = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const row = isUUID(intentId) ? await tx.paymentIntent.findUnique({ where: { id: intentId } }) : null
      if (!row || row.tenantId !== guest.tenantId || row.provider !== 'stripe' || !row.providerRef) {
        throw new NotFoundException({ code: 'not_found', message: 'No such card payment' })
      }
      const bill = await loadBill(tx, guest.tenantId, row.billId)
      await loadOrderForSession(tx, guest.tenantId, guest.sessionId, bill.orderId)
      const account = await tx.tenantPaymentAccount.findUnique({ where: { tenantId: guest.tenantId } })
      if (!account?.stripeAccountId) throw providerUnavailable()
      return { providerRef: row.providerRef, accountId: account.stripeAccountId, billId: row.billId }
    })
    const pi = await this.stripe.client().paymentIntents.retrieve(providerRef, {}, { stripeAccount: accountId })
    await this.applyStripeIntent(pi, accountId)
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      return this.bills.buildView(tx, guest, billId)
    })
  }

  /**
   * The one settlement path, for sync and the Connect webhook. Only acts on a PaymentIntent that is
   * provably ours: its row's providerRef, amount, currency and the tenant's connected account all match.
   * succeeded -> settle; a failed attempt -> cancelled at Stripe, then the row failed (so it can never
   * succeed behind a failed row); canceled -> cancelled. Anything else changes nothing.
   */
  async applyStripeIntent(pi: Stripe.PaymentIntent, accountId: string): Promise<'applied' | 'ignored'> {
    const { tenantId, intentId } = pi.metadata
    if (!tenantId || !intentId || !isUUID(tenantId) || !isUUID(intentId)) return 'ignored'
    const failed = pi.status === 'requires_payment_method' && pi.last_payment_error != null

    if (failed) {
      const row = await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, tenantId)
        return this.matchingRow(tx, tenantId, intentId, pi, accountId)
      })
      if (!row || !(ACTIVE_INTENT_STATUSES as readonly string[]).includes(row.status)) return 'ignored'
      if (await this.cancelAtStripe(row, accountId)) return 'applied'
    }

    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const row = await this.matchingRow(tx, tenantId, intentId, pi, accountId)
      if (!row) return 'ignored'
      if (pi.status === 'succeeded') {
        await this.settle(tx, tenantId, row)
        return 'applied'
      }
      if (failed) {
        // #286: a POS reader shows staff Stripe's own words; the phone path keeps the decline code.
        const error = pi.last_payment_error
        await failIntent(tx, row.id, (row.rail === 'card_terminal' ? error?.message : undefined) ?? error?.decline_code ?? error?.code ?? 'card_declined')
        return 'applied'
      }
      if (pi.status === 'canceled') {
        await tx.paymentIntent.updateMany({ where: { id: row.id, status: { in: [...ACTIVE_INTENT_STATUSES] } }, data: { status: 'cancelled', failureReason: 'cancelled_at_provider' } })
        return 'applied'
      }
      return 'ignored'
    })
  }

  private async matchingRow(tx: Tx, tenantId: string, intentId: string, pi: Stripe.PaymentIntent, accountId: string): Promise<IntentRow | null> {
    const row = await tx.paymentIntent.findUnique({ where: { id: intentId }, include: INTENT_INCLUDE })
    if (!row || row.tenantId !== tenantId || row.provider !== 'stripe' || row.providerRef !== pi.id) return null
    const account = await tx.tenantPaymentAccount.findUnique({ where: { tenantId } })
    if (account?.stripeAccountId !== accountId || BigInt(pi.amount) !== row.amountMinor || pi.currency !== row.currency.toLowerCase()) {
      this.logger.error(`Stripe PaymentIntent ${pi.id} does not match intent ${row.id} (account, amount or currency) - not settled`)
      return null
    }
    return row
  }

  /**
   * Cancels an attempt at Stripe. If Stripe refuses because the money already moved, that payment is
   * settled instead and true is returned (the caller's view of the bill is stale).
   */
  private async cancelAtStripe(row: IntentRow, accountId: string): Promise<boolean> {
    const stripe = this.stripe.client()
    const opts = { stripeAccount: accountId }
    if (!row.providerRef) return false
    try {
      await stripe.paymentIntents.cancel(row.providerRef, {}, opts)
      return false
    } catch (error) {
      const pi = await stripe.paymentIntents.retrieve(row.providerRef, {}, opts)
      if (pi.status === 'canceled') return false
      if (pi.status !== 'succeeded') throw error
      await this.applyStripeIntent(pi, accountId)
      return true
    }
  }

  /** Money moved: tender via confirmIntent, mark the share(s) paid, complete the bill when nothing is outstanding. */
  private async settle(tx: Tx, tenantId: string, row: IntentRow): Promise<void> {
    // Stripe took money for an attempt we had already closed (superseded, or cancelled by staff on
    // the POS): never a tender - flag it for a refund, the same as a late capture.
    if (row.status === 'failed' || row.status === 'cancelled') {
      if (row.failureReason === LATE_CAPTURE_REFUND_DUE) return
      await tx.paymentIntent.update({ where: { id: row.id }, data: { failureReason: LATE_CAPTURE_REFUND_DUE } })
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorEmail: 'system:payments',
          action: 'payment.late_capture_refund_due',
          reason: `Card payment ${row.id} (${row.amountMinor} ${row.currency}) succeeded at Stripe after it was ${row.status} - refund it to the customer`,
          occurredAt: new Date(),
        },
      })
      return
    }

    // #286: a POS card-reader payment is one whole-bill tender like the simulated terminal - no shares to settle.
    if (row.rail === 'card_terminal') {
      await confirmIntent(tx, { tenantId, intentId: row.id })
      return
    }

    await lockBill(tx, row.billId)
    const bill = await refreshOpenBillTotals(tx, await loadBill(tx, tenantId, row.billId))
    let refundDue = false
    if (bill.status === 'open' && row.status !== 'succeeded') {
      await this.bills.syncShares(tx, tenantId, bill)
      const shares = await tx.billShare.findMany({ where: { billId: bill.id } })
      if (row.shareId) {
        const share = shares.find((s) => s.id === row.shareId)
        // Paid another way meanwhile, or the bill changed so this share is no longer what was charged.
        refundDue = !share || share.status === 'paid' || share.amountMinor !== row.amountMinor
      } else {
        const tenderedMinor = bill.tenders.reduce((sum, t) => sum + t.amountMinor, 0n)
        refundDue = shares.some((s) => s.status === 'paid') || tenderedMinor + row.amountMinor !== BigInt(toBillView(bill).totalMinor)
      }
    }

    const intent = await confirmIntent(tx, { tenantId, intentId: row.id, refundDue })
    if (!intent.tender || bill.status !== 'open') return

    const payload = row.clientPayload as { payerPhone?: string | null } | null
    await tx.billShare.updateMany({
      where: row.shareId ? { id: row.shareId, status: 'outstanding' } : { billId: bill.id, status: 'outstanding' },
      data: { status: 'paid', payerPhone: payload?.payerPhone ?? null, tenderId: intent.tender.id, paidAt: new Date() },
    })
    if ((await tx.billShare.count({ where: { billId: bill.id, status: 'outstanding' } })) > 0) return

    // Every share is paid: any other attempt still open on this bill can only be a duplicate now
    // (and would block finalising). If one still captures, settle() flags it for a refund.
    await tx.paymentIntent.updateMany({
      where: { billId: bill.id, id: { not: row.id }, status: { in: [...ACTIVE_INTENT_STATUSES] } },
      data: { status: 'cancelled', failureReason: 'bill_settled' },
    })
    const order = await tx.order.findUniqueOrThrow({ where: { id: bill.orderId } })
    await this.bills.completeBill(tx, tenantId, bill, order)
  }

  /** Validates and prices a start under the bill lock - the same checks as pay-all / payShare. */
  private async plan(tx: Tx, guest: GuestPrincipal, billId: string, dto: StartCardPaymentDto): Promise<Plan> {
    await setTenantContext(tx, guest.tenantId)
    const cardPayments = await cardPaymentsFor(tx, guest)
    if (!cardPayments) throw providerUnavailable()
    await lockBill(tx, billId)
    const bill = await refreshOpenBillTotals(tx, await loadBill(tx, guest.tenantId, billId))
    await loadOrderForSession(tx, guest.tenantId, guest.sessionId, bill.orderId)
    if (bill.status === 'finalized') {
      throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
    }
    await assertSessionActive(tx, guest.tenantId, guest.sessionId)
    await this.bills.syncShares(tx, guest.tenantId, bill)

    let shareId: string | null = null
    let amountMinor: bigint
    if (dto.guestId) {
      const share = await tx.billShare.findUnique({ where: { billId_guestId: { billId, guestId: dto.guestId } } })
      if (!share || share.tenantId !== guest.tenantId) throw new NotFoundException({ code: 'not_found', message: 'No such share on this bill' })
      if (share.status === 'paid') throw new ConflictException({ code: 'share_already_paid', message: 'This share has already been paid' })
      shareId = share.id
      amountMinor = share.amountMinor
    } else {
      if ((await tx.billShare.count({ where: { billId, status: 'paid' } })) > 0) {
        throw new ConflictException({
          code: 'partial_payment_exists',
          message: 'One or more shares on this bill are already paid - pay the remaining shares individually',
        })
      }
      amountMinor = BigInt(toBillView(bill).totalMinor)
    }

    const account = await tx.tenantPaymentAccount.findUniqueOrThrow({ where: { tenantId: guest.tenantId } })
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: guest.tenantId }, select: { country: true } })
    const previous = await tx.paymentIntent.findFirst({
      where: { billId, shareId, provider: 'stripe', status: { in: [...OPEN_STATUSES] } },
      include: INTENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
    const reusable = previous !== null && previous.status !== 'expired' && previous.amountMinor === amountMinor
    if (reusable && dto.payerPhone) {
      await tx.paymentIntent.update({ where: { id: previous.id }, data: { clientPayload: { payerPhone: dto.payerPhone } } })
    }
    return {
      tenantId: guest.tenantId,
      billId,
      outletId: bill.outletId,
      shareId,
      amountMinor,
      currency: tenant.country === 'AU' ? 'AUD' : 'INR',
      accountId: cardPayments.stripeAccountId,
      feeMinor: applicationFeeMinor(amountMinor, account.feePercentBps, account.feeFixedMinor),
      reuse: reusable ? previous : null,
      stale: reusable ? null : previous,
    }
  }
}
