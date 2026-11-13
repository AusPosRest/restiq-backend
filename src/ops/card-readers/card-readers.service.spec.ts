// #286: the rules around card readers and reader orders that don't need a database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import type { ControlPlaneAuditService, OpsPrincipal, RegionRegistryService, StripeService } from '../../platform'
import { CardReadersService } from './card-readers.service'
import { cardOnFile, NEXT_STATUS, orderTotalMinor, PAYMENT_NOT_COMPLETED, ReaderOrdersService } from './reader-orders.service'

const TENANT = '01900000-0000-7000-8000-000000000001'
const ORDER = '01900000-0000-7000-8000-000000000002'
const OPERATOR: OpsPrincipal = { id: 'op-1', email: 'op@restiq.example' }
const savedKey = process.env.STRIPE_SECRET_KEY

afterEach(() => {
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = savedKey
})

describe('reader order rules', () => {
  it('moves forward only; cancel only before shipping', () => {
    expect(NEXT_STATUS.paid).toEqual(['ordered', 'cancelled'])
    expect(NEXT_STATUS.ordered).toEqual(['shipped', 'cancelled'])
    expect(NEXT_STATUS.shipped).toEqual(['delivered'])
    for (const done of ['delivered', 'cancelled', 'payment_failed'] as const) expect(NEXT_STATUS[done]).toEqual([])
  })

  it('total = unit price x quantity, in minor units', () => {
    expect(orderTotalMinor(29_900n, 3)).toBe(89_700n)
    expect(orderTotalMinor(0n, 5)).toBe(0n)
  })

  it('a card is on file only with an active or past-due card subscription', () => {
    const sub = { stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', cardBillingStatus: 'active' }
    expect(cardOnFile(sub)).toBe(true)
    expect(cardOnFile({ ...sub, cardBillingStatus: 'past_due' })).toBe(true)
    expect(cardOnFile({ ...sub, cardBillingStatus: 'pending' })).toBe(false)
    expect(cardOnFile({ ...sub, stripeSubscriptionId: null })).toBe(false)
    expect(cardOnFile(null)).toBe(false)
  })
})

describe('CardReadersService.register', () => {
  const stripeApi = { terminal: { readers: { create: vi.fn() }, locations: { create: vi.fn() } } }
  const tx = {
    $executeRaw: vi.fn(),
    tenant: { findUnique: vi.fn(() => Promise.resolve({ id: TENANT, name: 'T', country: 'AU' })) },
    tenantPaymentAccount: { findUnique: vi.fn(() => Promise.resolve({ stripeAccountId: 'acct_1', cardPaymentsActive: true })) },
    outlet: { findFirst: vi.fn(() => Promise.resolve({ id: 'outlet-1', name: 'Main', stripeTerminalLocationId: null })) },
  }
  const registry = { homeRegion: () => 'x', planeFor: () => ({ $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) }) } as unknown as RegionRegistryService
  const service = new CardReadersService(registry, { client: () => stripeApi } as unknown as StripeService, {} as ControlPlaneAuditService)
  const dto = { outletId: 'outlet-1', label: 'Front', registrationCode: 'simulated-wpe' }

  beforeEach(() => vi.clearAllMocks())

  it('refuses a simulated registration code on a live key, before touching Stripe', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_x'
    await expect(service.register(OPERATOR, TENANT, dto)).rejects.toMatchObject({ status: 400 })
    expect(stripeApi.terminal.readers.create).not.toHaveBeenCalled()
  })

  it("409 address_required for an outlet's first reader without an address", async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    await expect(service.register(OPERATOR, TENANT, dto)).rejects.toMatchObject({ status: 409, response: { code: 'address_required' } })
    expect(stripeApi.terminal.locations.create).not.toHaveBeenCalled()
  })

  it('409 provider_unavailable without an active Stripe account', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    tx.tenantPaymentAccount.findUnique.mockResolvedValueOnce({ stripeAccountId: 'acct_1', cardPaymentsActive: false })
    await expect(service.register(OPERATOR, TENANT, dto)).rejects.toMatchObject({ status: 409, response: { code: 'provider_unavailable' } })
  })
})

describe('ReaderOrdersService', () => {
  type Row = { id: string; tenantId: string; status: string; currency: string; totalMinor: bigint; stripeInvoiceId: string | null; failureMessage: string | null }
  let row: Row
  const stripeApi = {
    invoices: { retrieve: vi.fn(), create: vi.fn(), finalizeInvoice: vi.fn(), pay: vi.fn() },
    invoiceItems: { create: vi.fn() },
    refunds: { create: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
    customers: { retrieve: vi.fn() },
  }
  const tx = {
    $executeRaw: vi.fn(),
    readerOrder: {
      findUnique: vi.fn(() => Promise.resolve({ ...row })),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...row, tenant: { name: 'T' }, outlet: { name: 'Main' }, model: 's700', quantity: 1, unitPriceMinor: row.totalMinor, shipping: {}, createdAt: new Date(), updatedAt: new Date() })),
      updateMany: vi.fn((args: { where: { status: string }; data: Partial<Row> }) => {
        if (args.where.status !== row.status) return Promise.resolve({ count: 0 })
        Object.assign(row, args.data)
        return Promise.resolve({ count: 1 })
      }),
    },
    auditEvent: { create: vi.fn() },
  }
  const plane = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx), readerPrice: { findMany: vi.fn(() => Promise.resolve([])) } }
  const registry = { homeRegion: () => 'x', planeFor: () => plane } as unknown as RegionRegistryService
  const service = new ReaderOrdersService(registry, { client: () => stripeApi } as unknown as StripeService, {} as CardReadersService)
  const invoice = (over: Partial<Stripe.Invoice> = {}) => ({ id: 'in_1', currency: 'aud', amount_paid: 59_800, metadata: { readerOrderId: ORDER, tenantId: TENANT }, ...over }) as Stripe.Invoice

  beforeEach(() => {
    vi.clearAllMocks()
    row = { id: ORDER, tenantId: TENANT, status: 'payment_failed', currency: 'AUD', totalMinor: 59_800n, stripeInvoiceId: null, failureMessage: PAYMENT_NOT_COMPLETED }
  })

  it('webhook: invoice.paid marks a payment_failed order paid, once', async () => {
    await expect(service.applyInvoice(invoice(), true)).resolves.toBe('applied')
    expect(row).toMatchObject({ status: 'paid', stripeInvoiceId: 'in_1', failureMessage: null })
    await expect(service.applyInvoice(invoice(), true)).resolves.toBe('applied')
    await expect(service.applyInvoice(invoice(), false)).resolves.toBe('applied')
    expect(row.status).toBe('paid')
  })

  it('webhook: a wrong amount, currency, invoice or tenant is ignored', async () => {
    await expect(service.applyInvoice(invoice({ amount_paid: 1 }), true)).resolves.toBe('ignored')
    await expect(service.applyInvoice(invoice({ currency: 'inr' }), true)).resolves.toBe('ignored')
    await expect(service.applyInvoice(invoice({ metadata: { readerOrderId: ORDER, tenantId: '01900000-0000-7000-8000-00000000000f' } }), true)).resolves.toBe('ignored')
    row.stripeInvoiceId = 'in_other'
    await expect(service.applyInvoice(invoice(), true)).resolves.toBe('ignored')
    await expect(service.applyInvoice(invoice({ metadata: {} }), true)).resolves.toBe('ignored')
    expect(row.status).toBe('payment_failed')
  })

  it('webhook: invoice.payment_failed replaces only the placeholder message', async () => {
    await service.applyInvoice(invoice(), false)
    expect(row).toMatchObject({ status: 'payment_failed', failureMessage: 'The card payment failed', stripeInvoiceId: 'in_1' })
  })

  it('ops: an invalid transition is 409 and cancelling a paid order refunds its payment', async () => {
    row.status = 'paid'
    row.stripeInvoiceId = 'in_1'
    await expect(service.update(OPERATOR, ORDER, { status: 'delivered', reason: 'x' })).rejects.toMatchObject({ status: 409, response: { code: 'invalid_transition' } })
    stripeApi.invoices.retrieve.mockResolvedValue({ payments: { data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] } })
    await service.update(OPERATOR, ORDER, { status: 'cancelled', reason: 'Owner changed their mind' })
    expect(stripeApi.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: 'pi_1' }), { idempotencyKey: `restiq-reader-order-refund-${ORDER}` })
    expect(row.status).toBe('cancelled')
    expect(tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'reader_order.updated', reason: expect.stringContaining('Owner changed their mind') as string }) as object })
  })

  it('ops: shipping needs no refund', async () => {
    row.status = 'ordered'
    await service.update(OPERATOR, ORDER, { status: 'shipped', trackingRef: 'AP123', reason: 'Sent' })
    expect(stripeApi.refunds.create).not.toHaveBeenCalled()
    expect(row.status).toBe('shipped')
  })
})
