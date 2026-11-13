import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type { OpsPrincipal, PrismaService, RegionRegistryService, StripeService } from '../../platform'
import { SaveContractDto } from './subscriptions.dtos'
import { cardBillingFromStripe, periodAmountMinor, SubscriptionsService } from './subscriptions.service'

const TENANT_ID = '01900000-0000-7000-8000-000000000001'

describe('periodAmountMinor', () => {
  it('monthly charges the monthly price', () => {
    expect(periodAmountMinor(4900n, 'monthly', 20)).toBe(4900n)
  })
  it('annual charges 12 months less the discount, rounded half up', () => {
    expect(periodAmountMinor(4900n, 'annual', 20)).toBe(47040n) // 58800 * 0.8
    expect(periodAmountMinor(999n, 'annual', 15)).toBe(10190n) // 10189.8
    expect(periodAmountMinor(1001n, 'annual', 25)).toBe(9009n) // 9009.0
    expect(periodAmountMinor(1n, 'annual', 50)).toBe(6n) // 6.0
    expect(periodAmountMinor(7n, 'annual', 75)).toBe(21n) // 21.0
    expect(periodAmountMinor(3n, 'annual', 87)).toBe(5n) // 4.68
  })
})

describe('cardBillingFromStripe', () => {
  it('maps Stripe subscription statuses', () => {
    expect(cardBillingFromStripe('active')).toBe('active')
    expect(cardBillingFromStripe('past_due')).toBe('past_due')
    expect(cardBillingFromStripe('canceled')).toBe('canceled')
    expect(cardBillingFromStripe('incomplete')).toBe('pending')
    expect(cardBillingFromStripe('unpaid')).toBe('pending')
  })
})

type SubState = { id: string; status: string; suspendedAt: Date | null; stripeCustomerId: string | null; stripeSubscriptionId: string | null; cardBillingStatus: string | null }
type Item = { id: string; tenantId: string; description: string; quantity: number; unitAmountMinor: bigint; kind: 'recurring' | 'one_time'; sortOrder: number; billedAt: Date | null; createdAt: Date }

function harness(
  existing: Partial<SubState> | null = null,
  opts: { registered?: boolean; items?: Array<Partial<Item>>; monthlyPriceMinor?: bigint | null; billingPeriod?: string; stripeFails?: boolean } = {},
) {
  type Row = SubState & { currentPeriodStart: Date; currentPeriodEnd: Date }
  let sub: Row | null = existing
    ? { id: 'sub-row', status: 'active', suspendedAt: null, stripeCustomerId: null, stripeSubscriptionId: null, cardBillingStatus: null, currentPeriodStart: new Date(), currentPeriodEnd: new Date(), ...existing }
    : null
  let seq = 0
  const item = (fields: Partial<Item>): Item => ({
    id: `item-${++seq}`, tenantId: TENANT_ID, description: 'Line', quantity: 1, unitAmountMinor: 1000n, kind: 'recurring', sortOrder: seq, billedAt: null, createdAt: new Date(), ...fields,
  })
  let items: Item[] = (opts.items ?? []).map(item)
  const invoiceUpsert = vi.fn((_args: { where: unknown; create: unknown; update: unknown }) => Promise.resolve(_args))
  const auditCreate = vi.fn((_args: { data: Record<string, unknown> }) => Promise.resolve(_args))
  const tx = {
    $executeRaw: vi.fn(),
    tenant: { findUnique: vi.fn(() => Promise.resolve({ id: TENANT_ID, name: 'Spice Route', contactEmail: 'o@x.test', country: 'AU', plan: 'standard', billingPeriod: opts.billingPeriod ?? 'monthly', slug: null })) },
    subscription: {
      findUnique: vi.fn(() => Promise.resolve(sub)),
      upsert: vi.fn(({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        sub = sub ? { ...sub, ...update } : ({ id: 'sub-row', ...create } as Row)
        return Promise.resolve(sub)
      }),
    },
    invoice: { upsert: invoiceUpsert },
    auditEvent: { create: auditCreate },
    billingLineItem: {
      findMany: vi.fn(() => Promise.resolve([...items].sort((a, b) => a.sortOrder - b.sortOrder))),
      deleteMany: vi.fn(() => {
        items = items.filter((i) => i.billedAt)
        return Promise.resolve({ count: 0 })
      }),
      createMany: vi.fn(({ data }: { data: Array<Partial<Item>> }) => {
        items.push(...data.map(item))
        return Promise.resolve({ count: data.length })
      }),
      updateMany: vi.fn(({ where, data }: { where: { id: { in: string[] }; kind: string; billedAt: null }; data: { billedAt: Date } }) => {
        const hit = items.filter((i) => where.id.in.includes(i.id) && i.kind === where.kind && i.billedAt === null)
        hit.forEach((i) => (i.billedAt = data.billedAt))
        return Promise.resolve({ count: hit.length })
      }),
    },
  }
  const plane = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx))),
    planPrice: { findUnique: vi.fn(() => Promise.resolve(opts.monthlyPriceMinor === undefined ? null : { monthlyPriceMinor: opts.monthlyPriceMinor, annualDiscountPercent: 20 })) },
  }
  const prisma = {
    client: { tenantRegistryEntry: { findUnique: vi.fn(() => Promise.resolve(opts.registered === false ? null : { tenantId: TENANT_ID, region: 'in-mumbai', lifecycle: 'active' })) } },
  } as unknown as PrismaService
  const registry = { planeFor: () => plane, homeRegion: () => 'in-mumbai' } as unknown as RegionRegistryService
  const retrieve = vi.fn(() => Promise.resolve({ id: 'sub_1', metadata: { tenantId: TENANT_ID }, items: { data: [{ id: 'si_old' }] } }))
  const update = vi.fn<(id: string, params: Stripe.SubscriptionUpdateParams, options: Stripe.RequestOptions) => Promise<{ id: string }>>(() => (opts.stripeFails ? Promise.reject(new Error('No such subscription: sub_1')) : Promise.resolve({ id: 'sub_1' })))
  const productsCreate = vi.fn((params: { name: string }) => Promise.resolve({ id: `prod_${params.name}` }))
  const invoiceItemsCreate = vi.fn(() => Promise.resolve({ id: 'ii_1' }))
  const sessionsCreate = vi.fn<(params: Stripe.Checkout.SessionCreateParams) => Promise<{ url: string; expires_at: number }>>(() => Promise.resolve({ url: 'https://checkout.test/s', expires_at: 1_800_000_000 }))
  const customersCreate = vi.fn(() => Promise.resolve({ id: 'cus_new' }))
  const client = {
    subscriptions: { retrieve, update },
    products: { create: productsCreate },
    invoiceItems: { create: invoiceItemsCreate },
    checkout: { sessions: { create: sessionsCreate } },
    customers: { create: customersCreate },
  }
  const stripe = { client: () => client } as unknown as StripeService
  const service = new SubscriptionsService(prisma, registry, stripe)
  return { service, state: () => sub, items: () => items, invoiceUpsert, auditCreate, retrieve, update, productsCreate, invoiceItemsCreate, sessionsCreate }
}

function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    period_start: Date.UTC(2026, 10, 13) / 1000,
    amount_paid: 4900,
    amount_due: 4900,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { tenantId: TENANT_ID } } },
    ...overrides,
  }
}

describe('SubscriptionsService.applyStripeEvent', () => {
  it('checkout.session.completed stores the Stripe subscription and turns card billing on', async () => {
    const h = harness({ cardBillingStatus: 'pending', stripeCustomerId: 'cus_1' })
    const result = await h.service.applyStripeEvent(
      event('checkout.session.completed', { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { tenantId: TENANT_ID } }),
    )
    expect(result).toBe('applied')
    expect(h.state()).toMatchObject({ stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', cardBillingStatus: 'active', status: 'active' })
  })

  it('ignores a payment-mode checkout and events without a tenant', async () => {
    const h = harness()
    expect(await h.service.applyStripeEvent(event('checkout.session.completed', { mode: 'payment', metadata: { tenantId: TENANT_ID } }))).toBe('ignored')
    expect(await h.service.applyStripeEvent(event('customer.subscription.updated', { id: 'sub_1', status: 'active', metadata: {} }))).toBe('ignored')
    expect(h.state()).toBeNull()
  })

  it('invoice.paid upserts a paid invoice keyed by the Stripe id and clears arrears', async () => {
    const h = harness({ status: 'arrears' })
    expect(await h.service.applyStripeEvent(event('invoice.paid', invoice()))).toBe('applied')
    expect(h.state()?.status).toBe('active')
    expect(h.invoiceUpsert).toHaveBeenCalledWith({
      where: { stripeInvoiceId: 'in_1' },
      create: { tenantId: TENANT_ID, subscriptionId: 'sub-row', stripeInvoiceId: 'in_1', period: '2026-11', amountMinor: 4900n, status: 'paid' },
      update: { period: '2026-11', amountMinor: 4900n, status: 'paid' },
    })
  })

  it('invoice.paid never lifts an operator suspension', async () => {
    const h = harness({ status: 'suspended' })
    await h.service.applyStripeEvent(event('invoice.paid', invoice()))
    expect(h.state()?.status).toBe('suspended')
  })

  it('invoice.payment_failed marks the invoice overdue and the subscription in arrears', async () => {
    const h = harness({ status: 'active' })
    await h.service.applyStripeEvent(event('invoice.payment_failed', invoice({ amount_paid: 0 })))
    expect(h.state()?.status).toBe('arrears')
    expect(h.invoiceUpsert.mock.calls[0][0].update).toEqual({ period: '2026-11', amountMinor: 4900n, status: 'overdue' })
  })

  it('reads the tenant from the subscription when the invoice snapshot has no metadata', async () => {
    const h = harness()
    const inv = invoice({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: null } } })
    expect(await h.service.applyStripeEvent(event('invoice.paid', inv))).toBe('applied')
    expect(h.retrieve).toHaveBeenCalledWith('sub_1')
  })

  it('customer.subscription.updated/deleted set cardBillingStatus from the Stripe status', async () => {
    const h = harness({ stripeSubscriptionId: 'sub_1', cardBillingStatus: 'active' })
    await h.service.applyStripeEvent(event('customer.subscription.updated', { id: 'sub_1', status: 'past_due', metadata: { tenantId: TENANT_ID } }))
    expect(h.state()?.cardBillingStatus).toBe('past_due')
    await h.service.applyStripeEvent(event('customer.subscription.deleted', { id: 'sub_1', status: 'canceled', metadata: { tenantId: TENANT_ID } }))
    expect(h.state()?.cardBillingStatus).toBe('canceled')
  })

  it('an event for a replaced Stripe subscription leaves the current one alone', async () => {
    const h = harness({ stripeSubscriptionId: 'sub_new', cardBillingStatus: 'active' })
    await h.service.applyStripeEvent(event('customer.subscription.deleted', { id: 'sub_old', status: 'canceled', metadata: { tenantId: TENANT_ID } }))
    expect(h.state()?.cardBillingStatus).toBe('active')
  })

  it('unknown event types and unknown tenants are acknowledged and ignored', async () => {
    expect(await harness().service.applyStripeEvent(event('charge.refunded', {}))).toBe('ignored')
    const h = harness(null, { registered: false })
    expect(await h.service.applyStripeEvent(event('customer.subscription.updated', { id: 'sub_1', status: 'active', metadata: { tenantId: TENANT_ID } }))).toBe('ignored')
  })
})

const OPERATOR: OpsPrincipal = { id: 'op-1', email: 'op@restiq.test' }
const RECURRING = { description: 'POS licence', quantity: 2, unitAmountMinor: 2500, kind: 'recurring' as const }
const SETUP = { description: 'Setup fee', quantity: 1, unitAmountMinor: 9900, kind: 'one_time' as const }

describe('billing contract (#290)', () => {
  it('without items the contract view falls back to the plan price', async () => {
    const h = harness(null, { monthlyPriceMinor: 4900n })
    expect(await h.service.getContract(TENANT_ID)).toEqual({
      currency: 'AUD',
      billingPeriod: 'monthly',
      items: [],
      source: 'plan',
      recurringTotalMinor: '4900',
      nextInvoiceOneTimeMinor: '0',
      planAmountMinor: '4900',
      appliesFromNextInvoice: false,
    })
    expect((await h.service.get(TENANT_ID)).cardBilling.amountMinor).toBe('4900')
  })

  it('totals recurring and unbilled one-time items; billed items go last and no longer count', async () => {
    const billedAt = new Date('2026-11-01T00:00:00Z')
    const h = harness({ cardBillingStatus: 'active' }, {
      monthlyPriceMinor: 4900n,
      items: [{ ...SETUP, unitAmountMinor: 100n, description: 'Old setup', billedAt, sortOrder: 0 }, { ...RECURRING, unitAmountMinor: 2500n, sortOrder: 1 }, { ...SETUP, unitAmountMinor: 9900n, sortOrder: 2 }],
    })
    const view = await h.service.getContract(TENANT_ID)
    expect(view).toMatchObject({ source: 'contract', recurringTotalMinor: '5000', nextInvoiceOneTimeMinor: '9900', planAmountMinor: '4900', appliesFromNextInvoice: true })
    expect(view.items.map((i) => [i.description, i.billedAt])).toEqual([['POS licence', null], ['Setup fee', null], ['Old setup', billedAt.toISOString()]])
    expect((await h.service.get(TENANT_ID)).cardBilling.amountMinor).toBe('5000')
  })

  it('only billed items left means the plan applies again', async () => {
    const h = harness(null, { monthlyPriceMinor: null, items: [{ ...SETUP, unitAmountMinor: 100n, billedAt: new Date() }] })
    expect(await h.service.getContract(TENANT_ID)).toMatchObject({ source: 'plan', recurringTotalMinor: null, planAmountMinor: null, nextInvoiceOneTimeMinor: '0' })
  })

  it('one-time lines alone: the recurring total is the plan price Stripe keeps charging', async () => {
    const h = harness({ cardBillingStatus: 'active' }, { monthlyPriceMinor: 4900n, items: [{ ...SETUP, unitAmountMinor: 9900n }] })
    expect(await h.service.getContract(TENANT_ID)).toMatchObject({ source: 'contract', recurringTotalMinor: '4900', nextInvoiceOneTimeMinor: '9900' })
  })

  it('refuses more than 20 recurring lines (Stripe limit) before writing anything', async () => {
    const h = harness(null, { monthlyPriceMinor: 4900n })
    await expect(h.service.saveContract(OPERATOR, TENANT_ID, Array.from({ length: 21 }, () => RECURRING), 'Too many')).rejects.toMatchObject({ status: 400 })
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

  it('save replaces unbilled items in order, keeps billed ones, trims, audits, and never calls Stripe when billing is not active', async () => {
    const h = harness(null, { monthlyPriceMinor: 4900n, items: [{ ...RECURRING, unitAmountMinor: 1n }, { ...SETUP, unitAmountMinor: 5n, billedAt: new Date(), description: 'Billed' }] })
    const view = await h.service.saveContract(OPERATOR, TENANT_ID, [{ ...SETUP, description: '  Training  ' }, RECURRING], 'Signed contract')
    expect(view.items.map((i) => [i.description, i.kind])).toEqual([['Training', 'one_time'], ['POS licence', 'recurring'], ['Billed', 'one_time']])
    expect(h.items().filter((i) => !i.billedAt).map((i) => i.sortOrder)).toEqual([0, 1])
    expect(h.auditCreate.mock.calls[0][0].data).toMatchObject({ action: 'billing.contract_updated', reason: 'Signed contract', actorId: 'op-1' })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.productsCreate).not.toHaveBeenCalled()
  })

  it('billing-link without a contract charges the plan price, as before', async () => {
    const h = harness(null, { monthlyPriceMinor: 4900n })
    await h.service.billingLink(TENANT_ID)
    const params = h.sessionsCreate.mock.calls[0][0]
    expect(params.line_items).toEqual([
      { quantity: 1, price_data: { currency: 'aud', unit_amount: 4900, recurring: { interval: 'month' }, product_data: { name: 'Restiq standard plan (monthly)' } } },
    ])
    expect(params.metadata).toEqual({ tenantId: TENANT_ID })
  })

  it('billing-link with a contract: recurring lines every period, one-time lines once, ids in metadata', async () => {
    const h = harness(null, { monthlyPriceMinor: null, billingPeriod: 'annual', items: [{ ...RECURRING, unitAmountMinor: 2500n }, { ...SETUP, unitAmountMinor: 9900n }, { ...SETUP, unitAmountMinor: 1n, billedAt: new Date() }] })
    await h.service.billingLink(TENANT_ID)
    const params = h.sessionsCreate.mock.calls[0][0]
    expect(params.line_items).toEqual([
      { quantity: 2, price_data: { currency: 'aud', unit_amount: 2500, recurring: { interval: 'year' }, product_data: { name: 'POS licence' } } },
      { quantity: 1, price_data: { currency: 'aud', unit_amount: 9900, product_data: { name: 'Setup fee' } } },
    ])
    expect(params.metadata).toEqual({ tenantId: TENANT_ID, oneTimeItemIds: 'item-2' })
  })

  it('billing-link refuses a contract with only one-time lines (409 no_recurring_items)', async () => {
    const h = harness(null, { monthlyPriceMinor: 4900n, items: [{ ...SETUP, unitAmountMinor: 9900n }] })
    await expect(h.service.billingLink(TENANT_ID)).rejects.toMatchObject({ status: 409, response: { code: 'no_recurring_items' } })
    expect(h.sessionsCreate).not.toHaveBeenCalled()
  })

  it('checkout.session.completed marks the listed one-time items billed, once', async () => {
    const h = harness({ cardBillingStatus: 'pending' }, { items: [{ ...SETUP, unitAmountMinor: 9900n }, { ...SETUP, unitAmountMinor: 500n }] })
    const completed = event('checkout.session.completed', { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { tenantId: TENANT_ID, oneTimeItemIds: 'item-1' } })
    await h.service.applyStripeEvent(completed)
    const first = h.items()[0].billedAt
    expect(first).toBeInstanceOf(Date)
    expect(h.items()[1].billedAt).toBeNull()
    await h.service.applyStripeEvent(completed)
    expect(h.items()[0].billedAt).toBe(first)
  })

  it('save while card billing is active replaces the Stripe items without proration and invoices new one-time lines', async () => {
    const h = harness({ cardBillingStatus: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1' }, { monthlyPriceMinor: 4900n })
    const view = await h.service.saveContract(OPERATOR, TENANT_ID, [RECURRING, SETUP], 'Upsell')
    const [recurringId, setupId] = h.items().map((i) => i.id)
    expect(h.productsCreate).toHaveBeenCalledWith({ name: 'POS licence', metadata: { tenantId: TENANT_ID } }, { idempotencyKey: `restiq-contract-product-${TENANT_ID}-${recurringId}` })
    const [subscriptionId, params, options] = h.update.mock.calls[0]
    expect(subscriptionId).toBe('sub_1')
    expect(params).toEqual({
      items: [{ id: 'si_old', deleted: true }, { price_data: { currency: 'aud', product: 'prod_POS licence', unit_amount: 2500, recurring: { interval: 'month' } }, quantity: 2 }],
      proration_behavior: 'none',
    })
    expect(options.idempotencyKey).toMatch(new RegExp(`^restiq-contract-sync-${TENANT_ID}-`))
    expect(h.invoiceItemsCreate).toHaveBeenCalledWith(
      { customer: 'cus_1', subscription: 'sub_1', currency: 'aud', amount: 9900, description: 'Setup fee × 1' },
      { idempotencyKey: `restiq-contract-invoice-item-${TENANT_ID}-${setupId}` },
    )
    expect(view.items.find((i) => i.kind === 'one_time')?.billedAt).not.toBeNull()
    expect(view.nextInvoiceOneTimeMinor).toBe('0')
  })

  it('an emptied contract on an active subscription goes back to the plan price at Stripe', async () => {
    const h = harness({ cardBillingStatus: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1' }, { monthlyPriceMinor: 4900n, items: [{ ...RECURRING, unitAmountMinor: 2500n }] })
    await h.service.saveContract(OPERATOR, TENANT_ID, [], 'Back to plan')
    expect(h.update.mock.calls[0][1]).toMatchObject({ items: [{ id: 'si_old', deleted: true }, { price_data: { unit_amount: 4900 }, quantity: 1 }] })
  })

  it('an emptied contract on an active subscription without a plan price is refused before saving', async () => {
    const h = harness({ cardBillingStatus: 'active', stripeSubscriptionId: 'sub_1' }, { monthlyPriceMinor: null, items: [{ ...RECURRING, unitAmountMinor: 2500n }] })
    await expect(h.service.saveContract(OPERATOR, TENANT_ID, [], 'x')).rejects.toMatchObject({ status: 409, response: { code: 'price_not_set' } })
    expect(h.update).not.toHaveBeenCalled()
  })

  it('a Stripe failure keeps the saved contract and answers 502 stripe_sync_failed', async () => {
    const h = harness({ cardBillingStatus: 'active', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1' }, { monthlyPriceMinor: 4900n, stripeFails: true })
    const error: unknown = await h.service.saveContract(OPERATOR, TENANT_ID, [RECURRING, SETUP], 'Upsell').catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 502, response: { code: 'stripe_sync_failed' } })
    expect((error as { response: { message: string } }).response.message).toMatch(/^The contract was saved, but Stripe could not be updated \(No such subscription: sub_1\)/)
    expect(h.items()).toHaveLength(2)
    expect(h.items().every((i) => i.billedAt === null)).toBe(true)
    expect(h.auditCreate).toHaveBeenCalledTimes(1)
  })
})

describe('SaveContractDto', () => {
  const errors = (body: unknown) => validateSync(plainToInstance(SaveContractDto, body)).map((e) => e.property)

  it('accepts a valid body and an empty list', () => {
    expect(errors({ items: [RECURRING, SETUP], reason: 'ok' })).toEqual([])
    expect(errors({ items: [], reason: 'ok' })).toEqual([])
  })

  it('rejects bad items, too many items and a missing reason', () => {
    for (const bad of [
      { ...RECURRING, description: '   ' },
      { ...RECURRING, description: 'x'.repeat(121) },
      { ...RECURRING, quantity: 0 },
      { ...RECURRING, quantity: 1001 },
      { ...RECURRING, quantity: 1.5 },
      { ...RECURRING, unitAmountMinor: -1 },
      { ...RECURRING, unitAmountMinor: 100_000_001 },
      { ...RECURRING, kind: 'weekly' },
      'not an object',
    ]) {
      expect(errors({ items: [bad], reason: 'ok' }), JSON.stringify(bad)).toEqual(['items'])
    }
    expect(errors({ items: Array.from({ length: 31 }, () => RECURRING), reason: 'ok' })).toEqual(['items'])
    expect(errors({ items: [] })).toEqual(['reason'])
    expect(errors({ items: [], reason: 'x'.repeat(501) })).toEqual(['reason'])
  })
})
