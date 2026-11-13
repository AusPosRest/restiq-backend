import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { GuestPrincipal, RegionRegistryService, StripeService } from '../../platform'
import { LATE_CAPTURE_REFUND_DUE } from '../../pos/payments'
import { cardPaymentsFor, GuestBillsService } from './bills.service'
import { applicationFeeMinor, GuestCardPaymentsService } from './card-payments.service'
import { StripeConnectWebhookController } from './stripe-connect-webhook.controller'

// The pos/bills money core is covered by e2e; here it is stubbed so these pin #284's settlement rules.
// confirmIntent (pos/payments) is the real one, running against the in-memory rows below.
const state = vi.hoisted((): { billStatus: 'open' | 'finalized'; tenders: { amountMinor: bigint }[] } => ({ billStatus: 'open', tenders: [] }))
vi.mock('../../pos/bills', () => ({
  buildInvoiceView: vi.fn(),
  commitFinalize: vi.fn(),
  createOrGetBillRecord: vi.fn(),
  createTenderRecord: vi.fn(() => Promise.resolve({ id: 'tender-1' })),
  isUniqueViolation: () => false,
  loadBill: vi.fn(() => Promise.resolve({ id: 'bill-1', tenantId: TENANT, outletId: 'outlet-1', orderId: 'order-1', status: state.billStatus, tenders: state.tenders })),
  lockBill: vi.fn(),
  refreshOpenBillTotals: vi.fn((_tx: unknown, bill: unknown) => Promise.resolve(bill)),
  toBillView: vi.fn(() => ({ totalMinor: 2000 })),
}))

const TENANT = '01900000-0000-7000-8000-000000000001'
const INTENT = '01900000-0000-7000-8000-000000000002'
const SHARE = { id: 'share-1', billId: 'bill-1', amountMinor: 1000n, status: 'outstanding' }

type Row = { id: string; tenantId: string; rail: string; billId: string; shareId: string | null; provider: string; providerRef: string; amountMinor: bigint; currency: string; status: string; failureReason: string | null; clientPayload: unknown; tender: { id: string } | null }

function fakeTx(row: Row, opts: { shares?: (typeof SHARE)[]; outstandingAfter?: number } = {}) {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    paymentIntent: {
      findUnique: vi.fn(() => Promise.resolve({ ...row })),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...row })),
      updateMany: vi.fn((args: { where: { id?: string | { not: string }; status: { in: string[] } }; data: Partial<Row> }) => {
        if (args.where.id === row.id && args.where.status.in.includes(row.status)) {
          Object.assign(row, args.data)
          return Promise.resolve({ count: 1 })
        }
        return Promise.resolve({ count: 0 })
      }),
      update: vi.fn((args: { data: Partial<Row> }) => Promise.resolve(Object.assign(row, args.data))),
    },
    tenantPaymentAccount: { findUnique: vi.fn(() => Promise.resolve({ stripeAccountId: 'acct_1' })) },
    bill: { findUniqueOrThrow: vi.fn(() => Promise.resolve({ status: state.billStatus })) },
    billShare: {
      findMany: vi.fn(() => Promise.resolve(opts.shares ?? [SHARE])),
      updateMany: vi.fn(),
      count: vi.fn(() => Promise.resolve(opts.outstandingAfter ?? 0)),
    },
    order: { findUniqueOrThrow: vi.fn(() => Promise.resolve({ id: 'order-1', sessionId: 'session-1' })) },
    auditEvent: { create: vi.fn() },
  }
  return tx
}

// createTenderRecord is stubbed - mirror its effect on the row so confirmIntent sees its tender.
async function withTender(row: Row) {
  const { createTenderRecord } = await import('../../pos/bills')
  vi.mocked(createTenderRecord).mockImplementation(() => {
    row.tender = { id: 'tender-1' }
    return Promise.resolve({ id: 'tender-1' } as never)
  })
}

function setup(row: Row, opts?: Parameters<typeof fakeTx>[1]) {
  const tx = fakeTx(row, opts)
  const plane = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
  const registry = { homeRegion: () => 'au', planeFor: () => plane } as unknown as RegionRegistryService
  const bills = { syncShares: vi.fn(), completeBill: vi.fn(), buildView: vi.fn() }
  const stripeApi = { paymentIntents: { cancel: vi.fn(() => Promise.resolve({})), retrieve: vi.fn() } }
  const stripe = { client: () => stripeApi } as unknown as StripeService
  const service = new GuestCardPaymentsService(registry, stripe, bills as unknown as GuestBillsService)
  return { tx, bills, stripeApi, service }
}

function row(over: Partial<Row> = {}): Row {
  return { id: INTENT, tenantId: TENANT, rail: 'card_online', billId: 'bill-1', shareId: 'share-1', provider: 'stripe', providerRef: 'pi_1', amountMinor: 1000n, currency: 'AUD', status: 'pending', failureReason: null, clientPayload: { payerPhone: '+61 400 000 000' }, tender: null, ...over }
}

function pi(over: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return { id: 'pi_1', object: 'payment_intent', amount: 1000, currency: 'aud', status: 'succeeded', metadata: { tenantId: TENANT, intentId: INTENT }, last_payment_error: null, ...over } as Stripe.PaymentIntent
}

beforeEach(() => {
  vi.clearAllMocks()
  state.billStatus = 'open'
  state.tenders = []
})

describe('applicationFeeMinor', () => {
  it('is round(amount x bps / 10000) + fixed', () => {
    expect(applicationFeeMinor(1000n, 250, 30n)).toBe(55n)
    expect(applicationFeeMinor(1010n, 250, 0n)).toBe(25n) // 25.25 -> 25
    expect(applicationFeeMinor(1020n, 250, 0n)).toBe(26n) // 25.5 -> 26
    expect(applicationFeeMinor(1000n, 0, 0n)).toBe(0n)
  })
})

describe('card payment settlement (#284)', () => {
  it('a succeeded share payment writes the card_online tender and marks that share paid', async () => {
    const r = row()
    await withTender(r)
    const { tx, bills, service } = setup(r, { outstandingAfter: 1 })
    await expect(service.applyStripeIntent(pi(), 'acct_1')).resolves.toBe('applied')
    expect(r.status).toBe('succeeded')
    const { createTenderRecord } = await import('../../pos/bills')
    expect(createTenderRecord).toHaveBeenCalledWith(tx, expect.objectContaining({ method: 'card_online', amountMinor: 1000n, paymentIntentId: INTENT }))
    expect(tx.billShare.updateMany.mock.calls[0]).toMatchObject([
      { where: { id: 'share-1', status: 'outstanding' }, data: { status: 'paid', tenderId: 'tender-1', payerPhone: '+61 400 000 000' } },
    ])
    expect(bills.completeBill).not.toHaveBeenCalled()
  })

  it('a succeeded whole-bill payment marks every share paid and completes the bill', async () => {
    const r = row({ shareId: null, amountMinor: 2000n })
    await withTender(r)
    const { tx, bills, service } = setup(r, { outstandingAfter: 0 })
    await service.applyStripeIntent(pi({ amount: 2000 }), 'acct_1')
    expect(tx.billShare.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { billId: 'bill-1', status: 'outstanding' } }))
    expect(bills.completeBill).toHaveBeenCalledOnce()
  })

  it('is idempotent: a second delivery writes nothing more', async () => {
    const r = row()
    await withTender(r)
    const { service } = setup(r, { outstandingAfter: 1 })
    await service.applyStripeIntent(pi(), 'acct_1')
    await service.applyStripeIntent(pi(), 'acct_1')
    const { createTenderRecord } = await import('../../pos/bills')
    expect(createTenderRecord).toHaveBeenCalledOnce()
  })

  it('a capture on an already-finalized bill writes no tender and is flagged for a refund', async () => {
    state.billStatus = 'finalized'
    const r = row()
    await withTender(r)
    const { tx, service } = setup(r)
    await service.applyStripeIntent(pi(), 'acct_1')
    expect(r).toMatchObject({ status: 'succeeded', failureReason: LATE_CAPTURE_REFUND_DUE, tender: null })
    expect(tx.auditEvent.create.mock.calls[0]).toMatchObject([{ data: { action: 'payment.late_capture_refund_due' } }])
    expect(tx.billShare.updateMany).not.toHaveBeenCalled()
  })

  it('a share paid another way meanwhile is flagged for a refund, not tendered twice', async () => {
    const r = row()
    await withTender(r)
    const { tx, service } = setup(r, { shares: [{ ...SHARE, status: 'paid' }] })
    await service.applyStripeIntent(pi(), 'acct_1')
    expect(r).toMatchObject({ failureReason: LATE_CAPTURE_REFUND_DUE, tender: null })
    expect(tx.billShare.updateMany).not.toHaveBeenCalled()
  })

  it('money on an attempt we already cancelled is flagged for a refund', async () => {
    const r = row({ status: 'cancelled', failureReason: 'superseded' })
    const { tx, service } = setup(r)
    await service.applyStripeIntent(pi(), 'acct_1')
    expect(r.failureReason).toBe(LATE_CAPTURE_REFUND_DUE)
    expect(tx.auditEvent.create).toHaveBeenCalledOnce()
  })

  it('ignores a PaymentIntent whose amount, currency or account does not match the row', async () => {
    const r = row()
    const { service } = setup(r)
    await expect(service.applyStripeIntent(pi({ amount: 999 }), 'acct_1')).resolves.toBe('ignored')
    await expect(service.applyStripeIntent(pi({ currency: 'inr' }), 'acct_1')).resolves.toBe('ignored')
    await expect(service.applyStripeIntent(pi(), 'acct_other')).resolves.toBe('ignored')
    await expect(service.applyStripeIntent(pi({ metadata: {} }), 'acct_1')).resolves.toBe('ignored')
    expect(r.status).toBe('pending')
  })

  it('a declined card cancels the PaymentIntent at Stripe, then marks the row failed', async () => {
    const r = row()
    const { stripeApi, service } = setup(r)
    await service.applyStripeIntent(pi({ status: 'requires_payment_method', last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' } }), 'acct_1')
    expect(stripeApi.paymentIntents.cancel).toHaveBeenCalledWith('pi_1', {}, { stripeAccount: 'acct_1' })
    expect(r).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' })
  })

  it('a requires_payment_method intent nobody has tried yet is left alone', async () => {
    const r = row()
    const { stripeApi, service } = setup(r)
    await expect(service.applyStripeIntent(pi({ status: 'requires_payment_method' }), 'acct_1')).resolves.toBe('ignored')
    expect(stripeApi.paymentIntents.cancel).not.toHaveBeenCalled()
    expect(r.status).toBe('pending')
  })

  it('canceled at Stripe -> cancelled', async () => {
    const r = row()
    const { service } = setup(r)
    await service.applyStripeIntent(pi({ status: 'canceled' }), 'acct_1')
    expect(r.status).toBe('cancelled')
  })
})

describe('cardPayments availability (#284)', () => {
  const saved = { pk: process.env.STRIPE_PUBLISHABLE_KEY, sk: process.env.STRIPE_SECRET_KEY }
  beforeEach(() => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_unit'
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
  })
  afterEach(() => {
    for (const [name, value] of [['STRIPE_PUBLISHABLE_KEY', saved.pk], ['STRIPE_SECRET_KEY', saved.sk]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const tx = (liveSince: Date | null, active = true) =>
    ({
      tenant: { findUnique: () => Promise.resolve({ liveSince }) },
      tenantPaymentAccount: { findUnique: () => Promise.resolve({ stripeAccountId: 'acct_1', cardPaymentsActive: active, allowedMethods: ['apple_pay'] }) },
    }) as never
  const table = { tenantId: TENANT, tableId: 'table-1' }

  it('is set for a Live tenant with an active account, always offering card', async () => {
    await expect(cardPaymentsFor(tx(new Date()), table)).resolves.toEqual({ provider: 'stripe', publishableKey: 'pk_test_unit', stripeAccountId: 'acct_1', allowedMethods: ['card', 'apple_pay'] })
  })

  it('is null in Test mode, for an inactive account, without keys, and for a kiosk session', async () => {
    await expect(cardPaymentsFor(tx(null), table)).resolves.toBeNull()
    await expect(cardPaymentsFor(tx(new Date(), false), table)).resolves.toBeNull()
    await expect(cardPaymentsFor(tx(new Date()), { tenantId: TENANT, tableId: null })).resolves.toBeNull()
    delete process.env.STRIPE_PUBLISHABLE_KEY
    await expect(cardPaymentsFor(tx(new Date()), table)).resolves.toBeNull()
  })

  it('a kiosk session cannot start a card payment: 409 provider_unavailable, Stripe never called', async () => {
    const t = { $executeRaw: vi.fn(), ...(tx(new Date()) as object) }
    const plane = { $transaction: (fn: (x: unknown) => Promise<unknown>) => fn(t) }
    const create = vi.fn()
    const service = new GuestCardPaymentsService(
      { homeRegion: () => 'au', planeFor: () => plane } as unknown as RegionRegistryService,
      { client: () => ({ paymentIntents: { create } }) } as unknown as StripeService,
      {} as GuestBillsService,
    )
    const kiosk: GuestPrincipal = { id: 'g-1', sessionId: 's-1', tenantId: TENANT, outletId: 'o-1', tableId: null, name: 'Kiosk' }
    await expect(service.start(kiosk, 'bill-1', {})).rejects.toMatchObject({ status: 409, response: { code: 'provider_unavailable' } })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('StripeConnectWebhookController (#284)', () => {
  const SECRET = 'whsec_connect_unit'
  const saved = { key: process.env.STRIPE_SECRET_KEY, secret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET }
  const apply = vi.fn(() => Promise.resolve('applied' as const))
  const controller = new StripeConnectWebhookController(new StripeService(), { applyStripeIntent: apply } as unknown as GuestCardPaymentsService)
  const req = (raw: string) => ({ rawBody: Buffer.from(raw) }) as RawBodyRequest<Request>
  const sign = (payload: string, secret = SECRET) => new Stripe('sk_test_unit').webhooks.generateTestHeaderString({ payload, secret })
  const event = (type: string, account?: string) => JSON.stringify({ id: 'evt_1', object: 'event', type, account, data: { object: { id: 'pi_1', object: 'payment_intent' } } })

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET
    apply.mockClear()
  })
  afterEach(() => {
    for (const [name, value] of [['STRIPE_SECRET_KEY', saved.key], ['STRIPE_CONNECT_WEBHOOK_SECRET', saved.secret]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('settles a signed payment_intent event from a connected account', async () => {
    const body = event('payment_intent.succeeded', 'acct_1')
    await expect(controller.receive(req(body), sign(body))).resolves.toEqual({ received: true, result: 'applied' })
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_1' }), 'acct_1')
  })

  it('ignores other events and events without an account', async () => {
    for (const body of [event('charge.refunded', 'acct_1'), event('payment_intent.succeeded')]) {
      await expect(controller.receive(req(body), sign(body))).resolves.toEqual({ received: true, result: 'ignored' })
    }
    expect(apply).not.toHaveBeenCalled()
  })

  it('400s a signature from another endpoint (e.g. the platform secret)', async () => {
    const body = event('payment_intent.succeeded', 'acct_1')
    await expect(controller.receive(req(body), sign(body, 'whsec_platform'))).rejects.toMatchObject({ status: 400 })
    await expect(controller.receive(req(body), undefined)).rejects.toMatchObject({ status: 400 })
    expect(apply).not.toHaveBeenCalled()
  })
})
