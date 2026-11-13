// #286: when the POS uses Stripe card readers, and the simulate guard on them. Lifecycle is e2e.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuestCardPaymentsService } from '../../guest'
import type { CardReadersService } from '../../ops'
import type { PosPrincipal, RegionRegistryService, StripeService } from '../../platform'
import { PaymentIntentsService, stripeTerminalFor } from './intents.service'

const TENANT = '01900000-0000-7000-8000-000000000001'
const saved = process.env.STRIPE_SECRET_KEY

afterEach(() => {
  if (saved === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = saved
})

function fakeTx(opts: { live?: boolean; active?: boolean; readers?: number } = {}) {
  return {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    tenant: { findUnique: vi.fn(() => Promise.resolve({ liveSince: opts.live === false ? null : new Date(0) })) },
    tenantPaymentAccount: { findUnique: vi.fn(() => Promise.resolve({ stripeAccountId: 'acct_1', cardPaymentsActive: opts.active ?? true, feePercentBps: 250, feeFixedMinor: 30n })) },
    cardReader: { count: vi.fn(() => Promise.resolve(opts.readers ?? 1)), findFirst: vi.fn(() => Promise.resolve({ stripeReaderId: 'tmr_1' })) },
  }
}

describe('stripeTerminalFor (the reader-required rule)', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  })

  it('a Live tenant with an active account and a reader at the outlet uses Stripe readers', async () => {
    const tx = fakeTx()
    await expect(stripeTerminalFor(tx as never, TENANT, 'outlet-1')).resolves.toEqual({ accountId: 'acct_1', feePercentBps: 250, feeFixedMinor: 30n })
    expect(tx.cardReader.count).toHaveBeenCalledWith({ where: { tenantId: TENANT, outletId: 'outlet-1' } })
  })

  it('Test mode, an inactive account, no readers or no Stripe key keep the simulated terminal', async () => {
    await expect(stripeTerminalFor(fakeTx({ live: false }) as never, TENANT, 'o')).resolves.toBeNull()
    await expect(stripeTerminalFor(fakeTx({ active: false }) as never, TENANT, 'o')).resolves.toBeNull()
    await expect(stripeTerminalFor(fakeTx({ readers: 0 }) as never, TENANT, 'o')).resolves.toBeNull()
    delete process.env.STRIPE_SECRET_KEY
    await expect(stripeTerminalFor(fakeTx() as never, TENANT, 'o')).resolves.toBeNull()
  })
})

describe('simulate on a Stripe reader intent', () => {
  const intent = { id: 'i-1', tenantId: TENANT, billId: 'b-1', rail: 'card_terminal', provider: 'stripe', status: 'pending', providerRef: 'pi_1', clientPayload: { readerId: 'r-1', readerLabel: 'Front' }, amountMinor: 1000n, currency: 'AUD', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), succeededAt: null, failureReason: null, tender: null }
  const tx = { ...fakeTx(), paymentIntent: { findUnique: vi.fn(() => Promise.resolve({ ...intent })), findUniqueOrThrow: vi.fn(() => Promise.resolve({ ...intent })), updateMany: vi.fn() } }
  const registry = { homeRegion: () => 'x', planeFor: () => ({ $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) }) } as unknown as RegionRegistryService
  const stripeApi = {
    testHelpers: { terminal: { readers: { presentPaymentMethod: vi.fn() } } },
    paymentIntents: { retrieve: vi.fn(() => Promise.resolve({ id: 'pi_1', status: 'succeeded' })) },
  }
  const cards = { applyStripeIntent: vi.fn(() => Promise.resolve('applied')) }
  const service = new PaymentIntentsService(registry, { client: () => stripeApi } as unknown as StripeService, cards as unknown as GuestCardPaymentsService, {} as CardReadersService)
  const staff = { id: 's-1', tenantId: TENANT, outletId: 'outlet-1', name: 'A' } as PosPrincipal

  beforeEach(() => vi.clearAllMocks())

  it('404s with a live key - a real reader is only ever tapped by a real card', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_x'
    await expect(service.simulate(staff, 'i-1', { outcome: 'success' })).rejects.toMatchObject({ status: 404 })
    expect(stripeApi.testHelpers.terminal.readers.presentPaymentMethod).not.toHaveBeenCalled()
  })

  it('with a test key, taps 4242 (success) or 4000...0002 (failure) on the reader, then syncs', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    await service.simulate(staff, 'i-1', { outcome: 'success' })
    expect(stripeApi.testHelpers.terminal.readers.presentPaymentMethod).toHaveBeenLastCalledWith('tmr_1', { type: 'card_present', card_present: { number: '4242424242424242' } }, { stripeAccount: 'acct_1' })
    expect(cards.applyStripeIntent).toHaveBeenCalledWith(expect.objectContaining({ id: 'pi_1' }), 'acct_1')
    await service.simulate(staff, 'i-1', { outcome: 'failure' })
    expect(stripeApi.testHelpers.terminal.readers.presentPaymentMethod).toHaveBeenLastCalledWith('tmr_1', { type: 'card_present', card_present: { number: '4000000000000002' } }, { stripeAccount: 'acct_1' })
  })
})
