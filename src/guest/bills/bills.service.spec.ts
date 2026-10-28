import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuestPrincipal, RegionRegistryService } from '../../platform'
import { GuestBillsService } from './bills.service'

// The shared pos/bills money core is covered by the e2e suite - here it is stubbed so these tests
// pin only the guest side's payments gate (restiq-backend#278).
vi.mock('../../pos/bills', () => ({
  buildInvoiceView: vi.fn(),
  commitFinalize: vi.fn(),
  createOrGetBillRecord: vi.fn(() => Promise.resolve({ bill: BILL, created: true })),
  createTenderRecord: vi.fn(() => Promise.resolve({ id: 'tender-1' })),
  loadBill: vi.fn(() => Promise.resolve(BILL)),
  lockBill: vi.fn(),
  refreshOpenBillTotals: vi.fn((_tx: unknown, bill: unknown) => Promise.resolve(bill)),
  toBillView: vi.fn(() => ({ id: BILL.id, status: 'open', totalMinor: 1000 })),
}))
vi.mock('../../pos/payments', () => ({ confirmIntent: vi.fn() }))

const BILL = { id: 'bill-1', tenantId: 'tenant-1', outletId: 'outlet-1', orderId: 'order-1', status: 'open' }
const GUEST: GuestPrincipal = { id: 'g-1', sessionId: 'session-1', tenantId: 'tenant-1', outletId: 'outlet-1', tableId: 'table-1', name: 'Ana' }
const SHARE = { id: 'share-1', tenantId: 'tenant-1', billId: 'bill-1', guestId: 'g-1', guestName: 'Ana', amountMinor: 1000n, status: 'outstanding', payerPhone: null, paidAt: null, createdAt: new Date() }

function fakeTx(liveSince: Date | null) {
  return {
    $executeRaw: vi.fn(),
    tenant: { findUnique: vi.fn(() => Promise.resolve({ liveSince })) },
    order: { findUnique: vi.fn(() => Promise.resolve({ id: 'order-1', tenantId: 'tenant-1', sessionId: 'session-1', outletId: 'outlet-1', status: 'open' })) },
    bill: { findUnique: vi.fn(() => Promise.resolve(BILL)) },
    orderLine: { findMany: vi.fn(() => Promise.resolve([])) },
    tableSession: {
      findUnique: vi.fn(() => Promise.resolve({ id: 'session-1', tenantId: 'tenant-1', tableId: 'table-1', status: 'open', closedAt: null, expiresAt: new Date(Date.now() + 3_600_000) })),
      update: vi.fn(),
    },
    billShare: {
      findMany: vi.fn(() => Promise.resolve([SHARE])),
      findUnique: vi.fn(() => Promise.resolve(SHARE)),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(() => Promise.resolve(0)),
    },
  }
}

function serviceFor(tx: ReturnType<typeof fakeTx>) {
  const plane = { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
  return new GuestBillsService({ homeRegion: () => 'au', planeFor: () => plane } as unknown as RegionRegistryService)
}

describe('guest payments per tenant mode (restiq-backend#278)', () => {
  beforeEach(() => {
    process.env.PAYMENTS_SIMULATOR = 'off'
  })
  afterEach(() => {
    delete process.env.PAYMENTS_SIMULATOR
  })

  it('a Test-mode tenant pays a share and the whole bill with the server switch off', async () => {
    const tx = fakeTx(null)
    const service = serviceFor(tx)
    await expect(service.payShare(GUEST, 'bill-1', 'g-1', { simulatedOutcome: 'success' })).resolves.toMatchObject({ paymentsAvailable: true })
    await expect(service.payAll(GUEST, 'bill-1', { simulatedOutcome: 'success' })).resolves.toMatchObject({ paymentsAvailable: true })
  })

  it('a Live tenant still gets 409 provider_unavailable with the switch off', async () => {
    const service = serviceFor(fakeTx(new Date()))
    await expect(service.payShare(GUEST, 'bill-1', 'g-1', { simulatedOutcome: 'success' })).rejects.toMatchObject({ response: { code: 'provider_unavailable' } })
    await expect(service.payAll(GUEST, 'bill-1', { simulatedOutcome: 'success' })).rejects.toMatchObject({ response: { code: 'provider_unavailable' } })
  })

  it('the bill view says whether paying from the phone is available', async () => {
    const test = serviceFor(fakeTx(null))
    expect((await test.createBill(GUEST, 'order-1')).view.paymentsAvailable).toBe(true)
    expect((await test.getBill(GUEST, 'order-1')).paymentsAvailable).toBe(true)

    const live = serviceFor(fakeTx(new Date()))
    expect((await live.createBill(GUEST, 'order-1')).view.paymentsAvailable).toBe(false)
    expect((await live.getBill(GUEST, 'order-1')).paymentsAvailable).toBe(false)

    process.env.PAYMENTS_SIMULATOR = 'on'
    expect((await live.getBill(GUEST, 'order-1')).paymentsAvailable).toBe(true)
  })
})
