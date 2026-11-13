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
import Stripe from 'stripe'
import type { Prisma } from '../../generated/prisma/client'
import { applicationFeeMinor, GuestCardPaymentsService } from '../../guest'
import { CardReadersService, CardReaderView } from '../../ops'
import { paymentsSimulatorFor, PosPrincipal, RegionRegistryService, StripeService, stripeTestKey, tenantInTestMode, uuidv7 } from '../../platform'
import { isUniqueViolation, loadBill, lockBill, refreshOpenBillTotals, toBillView } from '../bills'
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

/**
 * #286: Stripe card readers take this outlet's card_terminal payments when the tenant is Live, its
 * Stripe account last read active, the server has a key, and the outlet has at least one reader.
 * Otherwise null - the simulated terminal, unchanged.
 */
export async function stripeTerminalFor(tx: Tx, tenantId: string, outletId: string): Promise<{ accountId: string; feePercentBps: number; feeFixedMinor: bigint } | null> {
  if (!process.env.STRIPE_SECRET_KEY || (await tenantInTestMode(tx, tenantId))) return null
  const account = await tx.tenantPaymentAccount.findUnique({ where: { tenantId } })
  if (!account?.stripeAccountId || !account.cardPaymentsActive) return null
  if ((await tx.cardReader.count({ where: { tenantId, outletId } })) === 0) return null
  return { accountId: account.stripeAccountId, feePercentBps: account.feePercentBps, feeFixedMinor: account.feeFixedMinor }
}

const isStripeReaderIntent = (intent: Pick<IntentRow, 'provider' | 'rail'>): boolean => intent.provider === 'stripe' && intent.rail === 'card_terminal'

// Stripe's test cards for the simulated reader (test key only).
const TEST_CARD = { success: '4242424242424242', failure: '4000000000000002' } as const

interface ReaderStart {
  accountId: string
  feeMinor: bigint
  stripeReaderId: string
}

@Injectable()
export class PaymentIntentsService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly stripe: StripeService,
    private readonly cards: GuestCardPaymentsService,
    private readonly readers: CardReadersService,
  ) {}

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
    const result = await plane.$transaction(async (tx): Promise<{ view: PaymentIntentView; created: boolean; start?: ReaderStart }> => {
      await setTenantContext(tx, staff.tenantId)
      // #170: the simulator is the only card provider so far - with it off there is nothing to send to.
      // #213: a tenant in Test mode always has it. #286: a Live outlet with Stripe card readers uses those.
      const simulator = await paymentsSimulatorFor(tx, staff.tenantId)
      await lockBill(tx, billId)
      const bill = await refreshOpenBillTotals(tx, await loadBill(tx, staff.tenantId, billId))
      const terminal = await stripeTerminalFor(tx, staff.tenantId, bill.outletId)
      if (!terminal && !simulator) {
        throw new ConflictException({
          code: 'provider_unavailable',
          message: 'Card terminal payments are not connected yet - take the card on your own terminal and record it as an external payment',
        })
      }
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
        // restiq-backend#210 (PE-22): staff-facing copy, no ids.
        throw new ConflictException({ code: 'intent_active', message: 'A card payment for this bill is already waiting on the terminal - cancel it there or wait for it to finish' })
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: staff.tenantId }, select: { country: true } })
      const currency = tenant.country === 'AU' ? 'AUD' : 'INR'

      if (terminal) {
        if (!dto.readerId) throw new BadRequestException({ code: 'reader_required', message: 'Choose the card reader to take this payment on' })
        const reader = await tx.cardReader.findFirst({ where: { id: dto.readerId, tenantId: staff.tenantId, outletId: bill.outletId } })
        if (!reader) throw new NotFoundException({ code: 'not_found', message: 'No such card reader at this outlet' })
        try {
          // Reserved as `created` before Stripe is called (the partial unique index keeps it the bill's only active intent).
          const intent = await tx.paymentIntent.create({
            data: {
              id: uuidv7(),
              tenantId: staff.tenantId,
              outletId: bill.outletId,
              billId,
              rail: dto.rail,
              provider: 'stripe',
              amountMinor: BigInt(dto.amountMinor),
              currency,
              status: 'created',
              clientKey: dto.clientKey,
              clientPayload: { readerId: reader.id, readerLabel: reader.label },
              expiresAt: new Date(Date.now() + INTENT_TTL_MS),
              createdByStaffId: staff.id,
            },
            include: INTENT_INCLUDE,
          })
          return {
            view: toPaymentIntentView(intent),
            created: true,
            start: { accountId: terminal.accountId, stripeReaderId: reader.stripeReaderId, feeMinor: applicationFeeMinor(BigInt(dto.amountMinor), terminal.feePercentBps, terminal.feeFixedMinor) },
          }
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException({ code: 'intent_active', message: 'A card payment for this bill is already waiting on the terminal - cancel it there or wait for it to finish' })
          }
          throw error
        }
      }

      // restiq-backend#210 (PE-22): never queue a payment no terminal will
      // pick up. It goes to this till's linked terminal, else the outlet-wide
      // queue - which only an active terminal not linked to another till drains.
      const targetDeviceId = await linkedPeripheral(tx, staff.tenantId, dto.deviceId, 'terminal')
      if (!targetDeviceId) {
        const outletTerminals = await tx.device.count({ where: { tenantId: staff.tenantId, outletId: bill.outletId, type: 'terminal', status: 'active', pairedPosId: null } })
        if (outletTerminals === 0) {
          throw new ConflictException({
            code: 'no_terminal',
            message: 'No card terminal is set up for this till. Take the card on your own machine and record it as External, or choose Cash or UPI.',
          })
        }
      }

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
            currency,
            status: 'pending',
            clientKey: dto.clientKey,
            clientPayload: { simulated: true },
            expiresAt: new Date(Date.now() + INTENT_TTL_MS),
            createdByStaffId: staff.id,
            // Issue #134: a POS with a linked terminal charges only there.
            targetDeviceId,
          },
          include: INTENT_INCLUDE,
        })
        return { view: toPaymentIntentView(intent), created: true }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException({ code: 'intent_active', message: 'A card payment for this bill is already waiting on the terminal - cancel it there or wait for it to finish' })
        }
        throw error
      }
    })
    if (!result.start) return { view: result.view, created: result.created }
    return { view: await this.startOnReader(staff.tenantId, result.view, result.start), created: true }
  }

  /**
   * #286: a Stripe PaymentIntent on the connected account (card_present, automatic capture, the
   * platform fee), then the reader is told to collect it. Stripe is never called inside a transaction.
   * A Stripe refusal (reader offline or busy, ...) fails the intent with Stripe's message.
   */
  private async startOnReader(tenantId: string, view: PaymentIntentView, start: ReaderStart): Promise<PaymentIntentView> {
    const stripe = this.stripe.client()
    const opts = { stripeAccount: start.accountId }
    let pi: Stripe.PaymentIntent | null = null
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: view.amountMinor,
          currency: view.currency.toLowerCase(),
          // API 2026-10-28.endive: payment_method_types is gone; allowed_payment_method_types narrows to in-person cards.
          allowed_payment_method_types: ['card_present'],
          capture_method: 'automatic',
          ...(start.feeMinor > 0n ? { application_fee_amount: Number(start.feeMinor) } : {}),
          metadata: { tenantId, billId: view.billId, intentId: view.id },
        },
        { ...opts, idempotencyKey: `restiq-pos-terminal-${view.id}` },
      )
      const piId = pi.id
      const saved = await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, tenantId)
        return tx.paymentIntent.updateMany({ where: { id: view.id, status: 'created' }, data: { status: 'pending', providerRef: piId } })
      })
      if (saved.count === 0) {
        // Cancelled (or expired) while Stripe answered - nothing goes to the reader.
        await stripe.paymentIntents.cancel(piId, {}, opts).catch(() => undefined)
      } else {
        await stripe.terminal.readers.processPaymentIntent(start.stripeReaderId, { payment_intent: piId }, { ...opts, idempotencyKey: `restiq-pos-terminal-process-${view.id}` })
      }
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError)) throw error
      if (pi) await stripe.paymentIntents.cancel(pi.id, {}, opts).catch(() => undefined)
      await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, tenantId)
        await failIntent(tx, view.id, error.message)
      })
    }
    return this.readView(tenantId, view.id)
  }

  private readView(tenantId: string, intentId: string): Promise<PaymentIntentView> {
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      return toPaymentIntentView(await expireIfDue(tx, await loadIntent(tx, tenantId, intentId)))
    })
  }

  /** The Stripe account and reader behind a Stripe reader intent (the reader may since have been removed). */
  private async readerContext(tenantId: string, intent: IntentRow): Promise<{ accountId: string | null; stripeReaderId: string | null }> {
    const readerId = (intent.clientPayload as { readerId?: string } | null)?.readerId
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const account = await tx.tenantPaymentAccount.findUnique({ where: { tenantId } })
      const reader = readerId ? await tx.cardReader.findFirst({ where: { id: readerId, tenantId } }) : null
      return { accountId: account?.stripeAccountId ?? null, stripeReaderId: reader?.stripeReaderId ?? null }
    })
  }

  /**
   * #286: brings a Stripe reader intent in step with Stripe. Money and declines go through the guest
   * card path's applyStripeIntent (the same matching checks and confirmIntent CAS as the webhook). A
   * reader action that failed without a card decline (customer cancelled, timed out) fails the intent
   * with Stripe's message. Past its expiry it is cancelled at Stripe before the read path expires it.
   */
  private async syncReaderIntent(tenantId: string, intent: IntentRow): Promise<void> {
    // An expired one is still read (a late capture is money - ADR-011), but never cancelled from here.
    if (!isStripeReaderIntent(intent) || !intent.providerRef || !(isIntentActive(intent) || intent.status === 'expired')) return
    const { accountId, stripeReaderId } = await this.readerContext(tenantId, intent)
    if (!accountId) return
    const stripe = this.stripe.client()
    const opts = { stripeAccount: accountId }
    const pi = await stripe.paymentIntents.retrieve(intent.providerRef, {}, opts)
    if ((await this.cards.applyStripeIntent(pi, accountId)) === 'applied') return
    if (pi.status !== 'requires_payment_method' || !stripeReaderId || !isIntentActive(intent)) return

    const reader = await stripe.terminal.readers.retrieve(stripeReaderId, {}, opts)
    const action = reader.deleted ? null : reader.action
    const failedHere = action?.type === 'process_payment_intent' && action.process_payment_intent?.payment_intent === pi.id && action.status === 'failed'
    if (failedHere || intent.expiresAt <= new Date()) {
      // Settled meanwhile? Then the cancel is refused and the capture is applied instead.
      if (await this.cancelAtStripe(tenantId, intent, accountId, stripeReaderId)) return
      if (failedHere) {
        await this.plane().$transaction(async (tx) => {
          await setTenantContext(tx, tenantId)
          await failIntent(tx, intent.id, action?.failure_message ?? 'The card reader could not take the payment')
        })
      }
    }
  }

  /** Clears the reader and cancels the PaymentIntent. True when Stripe refused because the money already moved (then settled). */
  private async cancelAtStripe(tenantId: string, intent: IntentRow, accountId: string, stripeReaderId: string | null): Promise<boolean> {
    const stripe = this.stripe.client()
    const opts = { stripeAccount: accountId }
    if (stripeReaderId) await stripe.terminal.readers.cancelAction(stripeReaderId, {}, opts).catch(() => undefined)
    if (!intent.providerRef) return false
    try {
      await stripe.paymentIntents.cancel(intent.providerRef, {}, opts)
      return false
    } catch (error) {
      const pi = await stripe.paymentIntents.retrieve(intent.providerRef, {}, opts)
      if (pi.status === 'canceled') return false
      if (pi.status !== 'succeeded') throw error
      await this.cards.applyStripeIntent(pi, accountId)
      return true
    }
  }

  /** GET payment-intents/:id - the settle screen's poll; expires lazily. #286: a Stripe reader intent syncs from Stripe first. */
  async getIntent(staff: PosPrincipal, intentId: string): Promise<PaymentIntentView> {
    const plane = this.plane()
    const intent = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      return loadIntent(tx, staff.tenantId, intentId)
    })
    await this.syncReaderIntent(staff.tenantId, intent)
    return this.readView(staff.tenantId, intentId)
  }

  /**
   * GET bills/:id/intents/active - the settle screen's resume after a reload: the bill's newest
   * still-open card terminal intent at this outlet (synced from Stripe for a reader intent, so it
   * may come back already settled), or null.
   */
  async activeForBill(staff: PosPrincipal, billId: string): Promise<{ intent: PaymentIntentView | null }> {
    const row = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      return tx.paymentIntent.findFirst({
        where: { tenantId: staff.tenantId, billId, outletId: staff.outletId, rail: 'card_terminal', status: { in: [...ACTIVE_INTENT_STATUSES] }, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
    })
    return { intent: row ? await this.getIntent(staff, row.id) : null }
  }

  /** GET outlets/:outletId/card-readers (#286) - the readers the POS can send a payment to; empty while the simulated terminal applies. */
  async listReaders(staff: PosPrincipal, outletId: string): Promise<{ readers: CardReaderView[] }> {
    if (outletId !== staff.outletId) throw new ForbiddenException({ code: 'outlet_mismatch', message: 'Not your outlet' })
    const { terminal, rows } = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const terminal = await stripeTerminalFor(tx, staff.tenantId, outletId)
      const rows = terminal ? await tx.cardReader.findMany({ where: { tenantId: staff.tenantId, outletId }, include: { outlet: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }) : []
      return { terminal, rows }
    })
    return { readers: terminal ? await this.readers.views(terminal.accountId, rows) : [] }
  }

  /** POST payment-intents/:id/cancel - idempotent on an already-over intent; refuses to cancel money that moved. */
  async cancelIntent(staff: PosPrincipal, intentId: string): Promise<PaymentIntentView> {
    const plane = this.plane()
    // #286: a Stripe reader intent is stopped at Stripe first (reader cleared, PaymentIntent cancelled);
    // if the card went through meanwhile, it is settled and the cancel below answers already_succeeded.
    const current = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      return loadIntent(tx, staff.tenantId, intentId)
    })
    if (isStripeReaderIntent(current) && isIntentActive(current)) {
      const { accountId, stripeReaderId } = await this.readerContext(staff.tenantId, current)
      if (accountId) await this.cancelAtStripe(staff.tenantId, current, accountId, stripeReaderId)
    }
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
        // #284: a Stripe intent is paid on the guest's phone, never on a terminal.
        where: { tenantId: staff.tenantId, outletId, status: { in: [...ACTIVE_INTENT_STATUSES] }, targetDeviceId, provider: { not: 'stripe' } },
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
    const current = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      return loadIntent(tx, staff.tenantId, intentId)
    })
    if (isStripeReaderIntent(current)) return this.simulateOnReader(staff, current, dto)
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const intent = await loadIntent(tx, staff.tenantId, intentId)
      // #170: with the simulator off the webhook does not exist, for old intents too.
      if (intent.provider !== 'simulated' || !(await paymentsSimulatorFor(tx, staff.tenantId))) {
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

  /**
   * #286: with a Stripe test key only (404 otherwise), taps Stripe's test card on the simulated reader -
   * 4242... approves, 4000...0002 declines - then syncs like the settle screen's poll.
   */
  private async simulateOnReader(staff: PosPrincipal, intent: IntentRow, dto: SimulateIntentDto): Promise<PaymentIntentView> {
    if (!stripeTestKey()) throw new NotFoundException({ code: 'not_found', message: 'No such payment intent' })
    if (intent.status === 'succeeded' && dto.outcome === 'success') return toPaymentIntentView(intent)
    if (intent.status === 'failed' && dto.outcome === 'failure') return toPaymentIntentView(intent)
    if (!isIntentActive(intent)) throw new ConflictException({ code: 'already_terminal', message: `This payment is already ${intent.status}` })
    const { accountId, stripeReaderId } = await this.readerContext(staff.tenantId, intent)
    if (!accountId || !stripeReaderId || !intent.providerRef) throw new ConflictException({ code: 'conflict', message: 'This payment is not on a card reader yet' })
    await this.stripe.client().testHelpers.terminal.readers.presentPaymentMethod(
      stripeReaderId,
      { type: 'card_present', card_present: { number: TEST_CARD[dto.outcome] } },
      { stripeAccount: accountId },
    )
    return this.getIntent(staff, intent.id)
  }
}
