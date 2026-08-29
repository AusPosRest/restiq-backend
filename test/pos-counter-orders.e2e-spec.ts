// pos/CAP-6 QSR counter and token mode, end to end (SPEC-pos-cashier-waiter,
// story 7, issue #62). This story composes over story 3/4's real Order/
// OrderLine endpoints and story 8's real Bill/Tender endpoints - it does not
// reimplement them, so these tests exercise the real create-order ->
// add-lines -> create-bill -> finalize-bill sequence end to end, not mocks.
//
// Success criteria under test:
//  - POST /pos/v1/outlets/:outletId/counter-orders creates a real
//    `tableId: null` Order and assigns a real, gapless-per-outlet sequential
//    token number in the same transaction
//  - token numbering survives a failed/aborted creation attempt without
//    gapping - same discipline as story 8's bill-numbering test
//    (test/pos-bills.e2e-spec.ts): the failing attempt never touches the
//    counter, so the next real creation still reserves the next number
//  - numbering is independent per outlet, same convention as bill numbers
//  - a table (dine-in) order never carries a token number
//  - the full compose-order -> add-lines -> bill -> finalize sequence
//    completes as one continuous flow, issuing a token at creation and
//    finalising the bill without any separate waiter hop
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface OrderBody {
  id: string
  tenantId: string
  outletId: string
  tableId: string | null
  ownerId: string
  status: 'open' | 'sent' | 'closed'
  tokenNumber: number | null
  createdAt: string
  updatedAt: string
}
interface BillBody {
  id: string
  orderId: string
  billNumber: number | null
  subtotalMinor: number
  taxMinor: number
  totalMinor: number
  status: 'open' | 'finalized'
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
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
  // qr-self-order/CAP-1 (guest realm, issue #68): Guest FKs to table_sessions
  // (RESTRICT), and table_sessions FKs to dining_tables/outlets - both wiped
  // before diningTable.deleteMany() below for the same reason.
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

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Koramangala'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'qsr', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name = 'Ravi'): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Cashier-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const token = signPosToken({ id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Quick Bites', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm' } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR', channel: 'dine_in' } })
  return item.id
}

describe('/pos/v1 QSR counter and token mode (e2e)', () => {
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

  describe('creating a counter order', () => {
    it('creates a tableId: null order owned by the caller, with a real token number', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const staff = await createStaff(prisma, tenantId, outletId)

      const res = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/counter-orders`), staff.token).send()
      expect(res.status).toBe(201)
      const order = res.body as OrderBody
      expect(order.tableId).toBeNull()
      expect(order.ownerId).toBe(staff.id)
      expect(order.status).toBe('open')
      expect(order.tokenNumber).toBe(1)
    })

    it('numbers tokens 1, 2, 3... gapless per outlet, and independently across outlets', async () => {
      const tenantId = await createTenant(prisma)
      const outletA = await createOutlet(prisma, tenantId, 'Outlet A')
      const outletB = await createOutlet(prisma, tenantId, 'Outlet B')
      const staffA = await createStaff(prisma, tenantId, outletA, 'Asha')
      const staffB = await createStaff(prisma, tenantId, outletB, 'Vikram')

      const a1 = await authed(request(httpServer).post(`/pos/v1/outlets/${outletA}/counter-orders`), staffA.token).send()
      const a2 = await authed(request(httpServer).post(`/pos/v1/outlets/${outletA}/counter-orders`), staffA.token).send()
      const a3 = await authed(request(httpServer).post(`/pos/v1/outlets/${outletA}/counter-orders`), staffA.token).send()
      expect((a1.body as OrderBody).tokenNumber).toBe(1)
      expect((a2.body as OrderBody).tokenNumber).toBe(2)
      expect((a3.body as OrderBody).tokenNumber).toBe(3)

      // A second outlet's sequence starts fresh at 1 - same per-outlet
      // independence as bill numbering (AD-14).
      const b1 = await authed(request(httpServer).post(`/pos/v1/outlets/${outletB}/counter-orders`), staffB.token).send()
      expect((b1.body as OrderBody).tokenNumber).toBe(1)
    })

    it('survives a failed/aborted creation attempt without gapping the next token', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const staff = await createStaff(prisma, tenantId, outletId)

      // Fails outlet validation BEFORE the gapless counter is ever touched -
      // proves the failure leaves no gap, same discipline as
      // test/pos-bills.e2e-spec.ts's gapless-numbering test.
      const failedAttempt = await authed(request(httpServer).post(`/pos/v1/outlets/${uuidv7()}/counter-orders`), staff.token).send()
      expect(failedAttempt.status).toBe(404)
      expect(await prisma.tokenNumberCounter.findUnique({ where: { outletId } })).toBeNull()

      const first = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/counter-orders`), staff.token).send()
      expect(first.status).toBe(201)
      expect((first.body as OrderBody).tokenNumber).toBe(1)

      const second = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/counter-orders`), staff.token).send()
      expect((second.body as OrderBody).tokenNumber).toBe(2)
    })

    it('rejects an outlet from a different tenant', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const staff = await createStaff(prisma, tenantId, outletId)
      const otherTenantId = await createTenant(prisma, 'Other Tenant')
      const otherOutletId = await createOutlet(prisma, otherTenantId, 'Other Outlet')

      const res = await authed(request(httpServer).post(`/pos/v1/outlets/${otherOutletId}/counter-orders`), staff.token).send()
      expect(res.status).toBe(404)
    })

    it('never assigns a token number to a table (dine-in) order', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const staff = await createStaff(prisma, tenantId, outletId)
      const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
      const table = await prisma.diningTable.create({
        data: { tenantId, floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 },
      })

      const res = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${table.id}/order`), staff.token).send()
      expect((res.body as OrderBody).tokenNumber).toBeNull()
    })
  })

  describe('the full counter-service flow, composed over the real order-line and bill endpoints', () => {
    it('rings up and settles a counter order in one continuous sequence: create -> add lines -> bill -> finalize', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const staff = await createStaff(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 15000)

      // 1. Compose: create the counter order and reserve its token, in one call.
      const created = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/counter-orders`), staff.token).send()
      expect(created.status).toBe(201)
      const order = created.body as OrderBody
      expect(order.tokenNumber).toBe(1)
      expect(order.status).toBe('open')

      // 2. Reuse story 4's real add-line endpoint unchanged.
      const withLines = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), staff.token).send({ itemId, quantity: 2 })
      expect(withLines.status).toBe(201)

      // 3. Reuse story 8's real create-bill endpoint unchanged - accepts an
      // "open" order directly, no kitchen-fire ("sent") hop required for a
      // counter order (SPEC CAP-6: "no separate waiter hop").
      const billRes = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/bill`), staff.token).send()
      expect(billRes.status).toBe(201)
      const bill = billRes.body as BillBody
      expect(bill.orderId).toBe(order.id)
      expect(bill.subtotalMinor).toBe(30000)
      expect(bill.status).toBe('open')

      // 4. Reuse story 8's real finalize endpoint unchanged - completes the
      // whole ring-up-and-settle action.
      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${bill.id}/finalize`), staff.token).send({
        tenders: [{ method: 'cash', amountMinor: bill.totalMinor }],
      })
      expect(finalized.status).toBe(200)
      expect((finalized.body as BillBody).status).toBe('finalized')
      expect((finalized.body as BillBody).billNumber).toBe(1)

      const closedOrder = await authed(request(httpServer).get(`/pos/v1/orders/${order.id}`), staff.token)
      expect((closedOrder.body as OrderBody).status).toBe('closed')
      // The token number issued at creation is preserved through to the
      // finalised order - it never gets overwritten by the bill number.
      expect((closedOrder.body as OrderBody).tokenNumber).toBe(1)
    })
  })
})
