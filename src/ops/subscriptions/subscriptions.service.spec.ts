import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type { PrismaService, RegionRegistryService, StripeService } from '../../platform'
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

function harness(existing: Partial<SubState> | null = null, opts: { registered?: boolean } = {}) {
  type Row = SubState & { currentPeriodStart: Date; currentPeriodEnd: Date }
  let sub: Row | null = existing
    ? { id: 'sub-row', status: 'active', suspendedAt: null, stripeCustomerId: null, stripeSubscriptionId: null, cardBillingStatus: null, currentPeriodStart: new Date(), currentPeriodEnd: new Date(), ...existing }
    : null
  const invoiceUpsert = vi.fn((_args: { where: unknown; create: unknown; update: unknown }) => Promise.resolve(_args))
  const tx = {
    $executeRaw: vi.fn(),
    tenant: { findUnique: vi.fn(() => Promise.resolve({ id: TENANT_ID, name: 'Spice Route', contactEmail: 'o@x.test', country: 'AU', plan: 'standard', billingPeriod: 'monthly' })) },
    subscription: {
      findUnique: vi.fn(() => Promise.resolve(sub)),
      upsert: vi.fn(({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        sub = sub ? { ...sub, ...update } : ({ id: 'sub-row', ...create } as Row)
        return Promise.resolve(sub)
      }),
    },
    invoice: { upsert: invoiceUpsert },
  }
  const plane = { $transaction: vi.fn((fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx))) }
  const prisma = {
    client: { tenantRegistryEntry: { findUnique: vi.fn(() => Promise.resolve(opts.registered === false ? null : { tenantId: TENANT_ID, region: 'in-mumbai', lifecycle: 'active' })) } },
  } as unknown as PrismaService
  const registry = { planeFor: () => plane, homeRegion: () => 'in-mumbai' } as unknown as RegionRegistryService
  const retrieve = vi.fn(() => Promise.resolve({ id: 'sub_1', metadata: { tenantId: TENANT_ID } }))
  const stripe = { client: () => ({ subscriptions: { retrieve } }) } as unknown as StripeService
  const service = new SubscriptionsService(prisma, registry, stripe)
  return { service, state: () => sub, invoiceUpsert, retrieve }
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
