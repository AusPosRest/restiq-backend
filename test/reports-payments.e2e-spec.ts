// tenant-admin/CAP-9 success criteria, end to end, issue #104: payments
// history. Real bills/tenders/credit notes (pos/CAP-7's Bill/Tender,
// pos/CAP-9's CreditNote) flow through the actual POS finalize/refund
// endpoints - same "drive it through the real API" seeding precedent as
// test/pos-refunds.e2e-spec.ts - rather than hand-crafting rows that would
// have to re-derive the same subtotal/tax/tender-sum invariants bill-core.ts
// already enforces.
//
// Proves:
//  - only finalized bills are returned, newest finalizedAt first
//  - totals cover the whole filtered range, not just one page
//  - keyset cursor pagination (limit=2) walks the full range with no gaps
//    or repeats
//  - outletId and from/to both narrow the result set
//  - an outletId from another tenant 404s (cross-tenant isolation)
//  - the CSV export has the right header and one row per finalized bill,
//    with tenders/credit notes flattened into "method=amount" cells
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signPosToken, uuidv7 } from '../src/platform'

interface TenderRowBody {
  method: string
  amountMinor: number
  createdAt: string
}
interface CreditNoteRowBody {
  id: string
  amountMinor: number
  reason: string
  createdAt: string
}
interface PaymentRowBody {
  billId: string
  billNumber: number
  finalizedAt: string
  outletId: string
  outletName: string
  orderId: string
  source: string
  tableLabel: string | null
  tokenNumber: number | null
  cashierName: string | null
  subtotalMinor: number
  discountMinor: number | null
  discountReason: string | null
  taxMinor: number
  totalMinor: number
  tenders: TenderRowBody[]
  creditNotes: CreditNoteRowBody[]
}
interface PaymentsTotalsBody {
  count: number
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  tenderedMinor: number
  refundedMinor: number
}
interface PaymentsListBody {
  items: PaymentRowBody[]
  nextCursor: string | null
  totals: PaymentsTotalsBody
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  await prisma.creditNoteLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.billShare.deleteMany()
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.subscription.deleteMany()
  await prisma.appliedOp.deleteMany()
  await prisma.syncDeadLetter.deleteMany()
  await prisma.device.deleteMany()
  await prisma.enrolmentCode.deleteMany()
  await prisma.menuImportDraft.deleteMany()
  await prisma.itemOutletOverride.deleteMany()
  await prisma.comboComponent.deleteMany()
  await prisma.combo.deleteMany()
  await prisma.itemAllergen.deleteMany()
  await prisma.allergen.deleteMany()
  await prisma.itemModifierGroup.deleteMany()
  await prisma.modifier.deleteMany()
  await prisma.modifierGroup.deleteMany()
  await prisma.itemPrice.deleteMany()
  await prisma.itemVariant.deleteMany()
  await prisma.menuItem.deleteMany()
  await prisma.menuCategory.deleteMany()
  await prisma.ticketEvent.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.order.deleteMany()
  await prisma.clockEvent.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
  await prisma.guest.deleteMany()
  await prisma.tableSession.deleteMany()
  await prisma.diningTable.deleteMany()
  await prisma.floor.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

async function createTenant(prisma: PrismaClient, name = 'Spice Route Hospitality'): Promise<string> {
  const tenantId = uuidv7()
  await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name,
      registeredAddress: '1 Test Street',
      contactName: 'Test Contact',
      contactEmail: 'contact@test.example',
      contactPhone: '+91 90000 00000',
      country: 'IN',
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  return tenantId
}

function adminToken(tenantId: string): string {
  return signAdminToken({ id: uuidv7(), tenantId, email: `owner-${tenantId}@spiceroute.example` })
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
  return outlet.id
}

async function createTable(prisma: PrismaClient, tenantId: string, outletId: string, label = 'T1'): Promise<string> {
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
  const table = await prisma.diningTable.create({ data: { tenantId, floorId: floor.id, label, x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 } })
  return table.id
}

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const token = signPosToken({ id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function createManagerPin(prisma: PrismaClient, tenantId: string, pin: string): Promise<void> {
  const role = await prisma.role.create({ data: { tenantId, name: `Manager-${uuidv7()}`, isSystem: false, isManager: true } })
  await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Manager', pinHash: await argon2.hash(pin) } })
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm' } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR', channel: 'dine_in' } })
  return item.id
}

describe('/admin/v1/reports/payments (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
  })

  function authed(req: request.Test, token: string): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  /** Opens a table order, adds `quantity` lines at priceMinor, sends, bills, and (unless skipFinalize) finalizes with a single tender for the exact total. */
  async function createBill(
    tenantId: string,
    outletId: string,
    tableId: string,
    cashierToken: string,
    priceMinor: number,
    quantity: number,
    opts: { tenderMethod?: 'cash' | 'upi_manual'; skipFinalize?: boolean } = {},
  ): Promise<{ billId: string; orderId: string; subtotalMinor: number; taxMinor: number; totalMinor: number }> {
    const itemId = await createItemWithPrice(prisma, tenantId, priceMinor)
    const opened = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), cashierToken).send()
    const orderId = (opened.body as { id: string }).id
    await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), cashierToken).send({ itemId, quantity })
    await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), cashierToken).send({ status: 'sent' })

    const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), cashierToken).send()
    const bill = created.body as { id: string; subtotalMinor: number; taxMinor: number }
    const totalMinor = bill.subtotalMinor + bill.taxMinor
    if (opts.skipFinalize) {
      return { billId: bill.id, orderId, subtotalMinor: bill.subtotalMinor, taxMinor: bill.taxMinor, totalMinor }
    }

    await authed(request(httpServer).post(`/pos/v1/bills/${bill.id}/finalize`), cashierToken).send({
      tenders: [{ method: opts.tenderMethod ?? 'cash', amountMinor: totalMinor }],
    })
    return { billId: bill.id, orderId, subtotalMinor: bill.subtotalMinor, taxMinor: bill.taxMinor, totalMinor }
  }

  /** Full seed: tenant with two outlets. Outlet 1 gets 3 finalized bills (cash, upi, cash-then-refunded) at controlled, distinct finalizedAt times plus 1 still-open bill; outlet 2 gets 1 finalized bill. Returns everything a test might assert against. */
  async function seedTenant(name: string) {
    const tenantId = await createTenant(prisma, name)
    const outlet1 = await createOutlet(prisma, tenantId, `${name} Main`)
    const outlet2 = await createOutlet(prisma, tenantId, `${name} Annex`)
    const table1 = await createTable(prisma, tenantId, outlet1, 'T1')
    const table2 = await createTable(prisma, tenantId, outlet2, 'T2')
    const cashier = await createStaff(prisma, tenantId, outlet1, 'Asha')
    const cashier2 = await createStaff(prisma, tenantId, outlet2, 'Vikram')
    const managerPin = '1234'
    await createManagerPin(prisma, tenantId, managerPin)

    const now = Date.now()
    const t1 = new Date(now - 3 * 3600_000) // oldest
    const t2 = new Date(now - 2 * 3600_000)
    const t3 = new Date(now - 1 * 3600_000) // newest

    const b1 = await createBill(tenantId, outlet1, table1, cashier.token, 10000, 1, { tenderMethod: 'cash' }) // subtotal 10000, tax 500, total 10500
    await prisma.bill.update({ where: { id: b1.billId }, data: { finalizedAt: t1 } })

    const b2 = await createBill(tenantId, outlet1, table1, cashier.token, 10000, 2, { tenderMethod: 'upi_manual' }) // subtotal 20000, tax 1000, total 21000
    await prisma.bill.update({ where: { id: b2.billId }, data: { finalizedAt: t2 } })

    const b3 = await createBill(tenantId, outlet1, table1, cashier.token, 10000, 3, { tenderMethod: 'cash' }) // subtotal 30000, tax 1500, total 31500
    await authed(request(httpServer).post(`/pos/v1/bills/${b3.billId}/refund`), cashier.token).send({ managerPin, reason: 'Sent back' })
    await prisma.bill.update({ where: { id: b3.billId }, data: { finalizedAt: t3 } })

    const openBill = await createBill(tenantId, outlet1, table1, cashier.token, 10000, 1, { skipFinalize: true })

    const b5 = await createBill(tenantId, outlet2, table2, cashier2.token, 8000, 1, { tenderMethod: 'cash' }) // subtotal 8000, tax 400, total 8400

    return { tenantId, outlet1, outlet2, token: adminToken(tenantId), b1, b2, b3, b5, openBillId: openBill.billId, t1, t2, t3 }
  }

  describe('GET /admin/v1/reports/payments', () => {
    it('rejects without an admin token', async () => {
      const res = await request(httpServer).get('/admin/v1/reports/payments')
      expect(res.status).toBe(401)
    })

    it('returns only finalized bills, newest finalizedAt first, with the open bill excluded', async () => {
      const seed = await seedTenant('Newest First')
      const res = await authed(request(httpServer).get(`/admin/v1/reports/payments?outletId=${seed.outlet1}`), seed.token)
      expect(res.status).toBe(200)
      const body = res.body as PaymentsListBody

      expect(body.items.map((i) => i.billId)).toEqual([seed.b3.billId, seed.b2.billId, seed.b1.billId])
      expect(body.items.some((i) => i.billId === seed.openBillId)).toBe(false)

      const b3Row = body.items[0]
      expect(b3Row).toMatchObject({
        outletId: seed.outlet1,
        source: 'pos',
        tableLabel: 'T1',
        tokenNumber: null,
        cashierName: 'Asha',
        subtotalMinor: 30000,
        discountMinor: null,
        taxMinor: 1500,
        totalMinor: 31500,
      })
      expect(b3Row.tenders).toEqual([{ method: 'cash', amountMinor: 31500, createdAt: expect.any(String) as string }])
      expect(b3Row.creditNotes).toHaveLength(1)
      expect(b3Row.creditNotes[0]).toMatchObject({ amountMinor: 31500, reason: 'Sent back' })

      const b2Row = body.items[1]
      expect(b2Row.tenders).toEqual([{ method: 'upi_manual', amountMinor: 21000, createdAt: expect.any(String) as string }])
      expect(b2Row.creditNotes).toEqual([])
    })

    it('totals cover the whole filtered range, not just the returned page', async () => {
      const seed = await seedTenant('Totals')
      const res = await authed(request(httpServer).get(`/admin/v1/reports/payments?outletId=${seed.outlet1}&limit=1`), seed.token)
      const body = res.body as PaymentsListBody

      expect(body.items).toHaveLength(1)
      expect(body.totals).toEqual({
        count: 3,
        subtotalMinor: 60000,
        discountMinor: 0,
        taxMinor: 3000,
        totalMinor: 63000,
        tenderedMinor: 63000,
        refundedMinor: 31500,
      })
    })

    it('paginates with a keyset cursor (limit=2) covering all 3 finalized bills with no gaps or repeats', async () => {
      const seed = await seedTenant('Cursor')
      const first = await authed(request(httpServer).get(`/admin/v1/reports/payments?outletId=${seed.outlet1}&limit=2`), seed.token)
      const firstBody = first.body as PaymentsListBody
      expect(firstBody.items.map((i) => i.billId)).toEqual([seed.b3.billId, seed.b2.billId])
      expect(firstBody.nextCursor).not.toBeNull()

      const second = await authed(
        request(httpServer).get(`/admin/v1/reports/payments?outletId=${seed.outlet1}&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`),
        seed.token,
      )
      const secondBody = second.body as PaymentsListBody
      expect(secondBody.items.map((i) => i.billId)).toEqual([seed.b1.billId])
      expect(secondBody.nextCursor).toBeNull()

      // Whole-range totals are identical on every page.
      expect(secondBody.totals).toEqual(firstBody.totals)
    })

    it('filters by outletId', async () => {
      const seed = await seedTenant('Outlet Filter')
      const res = await authed(request(httpServer).get(`/admin/v1/reports/payments?outletId=${seed.outlet2}`), seed.token)
      const body = res.body as PaymentsListBody
      expect(body.items.map((i) => i.billId)).toEqual([seed.b5.billId])
      expect(body.totals.count).toBe(1)
      expect(body.totals.totalMinor).toBe(8400)
    })

    it('filters by from/to on finalizedAt', async () => {
      const seed = await seedTenant('Date Filter')
      const from = new Date(seed.t2.getTime() - 1000).toISOString()
      const to = new Date(seed.t2.getTime() + 1000).toISOString()
      const res = await authed(request(httpServer).get(`/admin/v1/reports/payments?outletId=${seed.outlet1}&from=${from}&to=${to}`), seed.token)
      const body = res.body as PaymentsListBody
      expect(body.items.map((i) => i.billId)).toEqual([seed.b2.billId])
      expect(body.totals.count).toBe(1)
    })

    it('404s when outletId belongs to another tenant (cross-tenant isolation)', async () => {
      const seedA = await seedTenant('Tenant A')
      const seedB = await seedTenant('Tenant B')
      const res = await authed(request(httpServer).get(`/admin/v1/reports/payments?outletId=${seedA.outlet1}`), seedB.token)
      expect(res.status).toBe(404)
    })

    it('rejects an out-of-range limit', async () => {
      const seed = await seedTenant('Bad Limit')
      const res = await authed(request(httpServer).get(`/admin/v1/reports/payments?outletId=${seed.outlet1}&limit=500`), seed.token)
      expect(res.status).toBe(400)
    })
  })

  describe('GET /admin/v1/reports/payments/export', () => {
    it('exports a real CSV with the right header and one row per finalized bill', async () => {
      const seed = await seedTenant('CSV Export')
      const res = await authed(request(httpServer).get(`/admin/v1/reports/payments/export?outletId=${seed.outlet1}`), seed.token)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.headers['content-disposition']).toContain('payments.csv')

      const rows = res.text
        .trim()
        .split('\r\n')
        .map((line) => line.split(','))
      expect(rows[0]).toEqual(['bill_number', 'finalized_at', 'outlet', 'source', 'table', 'token_number', 'cashier', 'subtotal', 'discount', 'discount_reason', 'tax', 'total', 'tenders', 'credit_notes'])
      expect(rows).toHaveLength(4) // header + 3 finalized bills

      const b3Row = rows[1] // newest first
      expect(b3Row.slice(2)).toEqual(['CSV Export Main', 'pos', 'T1', '', 'Asha', '300.00', '0.00', '', '15.00', '315.00', 'cash=315.00', 'Sent back=315.00'])
    })
  })
})
