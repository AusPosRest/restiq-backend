// pos/CAP-9 refunds & adjustments, end to end (SPEC-pos-cashier-waiter,
// story 10). Proves the story's success criteria:
//  - a refund against a finalized Bill creates a CreditNote without
//    mutating the Bill (its status/number/totals are untouched)
//  - a refund without a valid manager PIN is rejected (platform/manager-auth,
//    real gate, same as story 8's discount-above-threshold)
//  - tax reversal is arithmetically correct against the original bill's real
//    5% placeholder tax rate (bills.service.ts's TAX_RATE_PLACEHOLDER_PERCENT)
//  - a refund attempt against a still-open (non-finalized) Bill is rejected
//  - cross-tenant isolation (404, not leaked data)
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface TenderBody {
  id: string
  method: string
  amountMinor: number
}
interface BillBody {
  id: string
  orderId: string
  billNumber: number | null
  subtotalMinor: number
  taxMinor: number
  discountMinor: number | null
  totalMinor: number
  status: 'open' | 'finalized'
  tenders: TenderBody[]
}
interface OrderLineBody {
  id: string
  quantity: number
}
interface OrderBody {
  id: string
  status: 'open' | 'sent' | 'closed'
  lines: OrderLineBody[]
}
interface CreditNoteLineBody {
  id: string
  orderLineId: string
  quantity: number
  unitPriceMinor: number
  amountMinor: number
}
interface CreditNoteBody {
  id: string
  tenantId: string
  originalBillId: string
  reason: string
  approvedByStaffId: string
  createdByStaffId: string
  subtotalMinor: number
  taxMinor: number
  totalMinor: number
  createdAt: string
  lines: CreditNoteLineBody[]
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.creditNoteLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
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

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createTable(prisma: PrismaClient, tenantId: string, outletId: string, label = 'T1'): Promise<string> {
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
  const table = await prisma.diningTable.create({
    data: { tenantId, floorId: floor.id, label, x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 },
  })
  return table.id
}

async function createStaff(
  prisma: PrismaClient,
  tenantId: string,
  outletId: string,
  name: string,
  opts?: { isManager?: boolean; pin?: string },
): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uuidv7()}`, isSystem: false, isManager: opts?.isManager ?? false } })
  const pinHash = opts?.pin ? await argon2.hash(opts.pin) : undefined
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name, pinHash } })
  const token = signPosToken({ id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm' } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR', channel: 'dine_in' } })
  return item.id
}

describe('/pos/v1 refunds and adjustments (e2e)', () => {
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

  /**
   * Opens a table order, adds one line (quantity 2) at priceMinor, sends it
   * to the kitchen, bills it, and finalizes with a single cash tender for
   * the exact total. Returns the finalized bill, the order's line id, and a
   * manager PIN valid for this tenant.
   */
  async function setUpFinalizedBill(
    tenantId: string,
    outletId: string,
    priceMinor: number,
  ): Promise<{ billId: string; orderId: string; orderLineId: string; cashierToken: string; managerPin: string; bill: BillBody }> {
    const tableId = await createTable(prisma, tenantId, outletId)
    const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
    const managerPin = '1234'
    await createStaff(prisma, tenantId, outletId, 'Meera Manager', { isManager: true, pin: managerPin })
    const itemId = await createItemWithPrice(prisma, tenantId, priceMinor)

    const opened = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()
    const orderId = (opened.body as { id: string }).id
    await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), owner.token).send({ itemId, quantity: 2 })
    await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), owner.token).send({ status: 'sent' })

    const orderRes = await authed(request(httpServer).get(`/pos/v1/orders/${orderId}`), owner.token)
    const orderLineId = (orderRes.body as OrderBody).lines[0].id

    const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), owner.token).send()
    const billId = (created.body as BillBody).id
    const totalMinor = (created.body as BillBody).subtotalMinor + (created.body as BillBody).taxMinor

    const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), owner.token).send({
      tenders: [{ method: 'cash', amountMinor: totalMinor }],
    })

    return { billId, orderId, orderLineId, cashierToken: owner.token, managerPin, bill: finalized.body as BillBody }
  }

  describe('refunding a finalized bill', () => {
    it('creates a CreditNote without mutating the original Bill (full refund, no lines given)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderLineId, cashierToken, managerPin, bill } = await setUpFinalizedBill(tenantId, outletId, 10000) // 2 x 10000 = 20000 subtotal, 1000 tax

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        managerPin,
        reason: 'Customer sent both dishes back',
      })
      expect(res.status).toBe(201)
      const note = res.body as CreditNoteBody
      expect(note.originalBillId).toBe(billId)
      expect(note.reason).toBe('Customer sent both dishes back')
      expect(note.subtotalMinor).toBe(20000)
      expect(note.taxMinor).toBe(1000) // 5% of 20000, the same documented placeholder rate
      expect(note.totalMinor).toBe(21000)
      expect(note.lines).toHaveLength(1)
      expect(note.lines[0]).toMatchObject({ orderLineId, quantity: 2, unitPriceMinor: 10000, amountMinor: 20000 })

      // The Bill itself is untouched - same status, number, and totals.
      const fetched = await authed(request(httpServer).get(`/pos/v1/bills/${billId}`), cashierToken)
      expect(fetched.body).toMatchObject({ status: 'finalized', billNumber: bill.billNumber, subtotalMinor: bill.subtotalMinor, taxMinor: bill.taxMinor })

      const dbBill = await prisma.bill.findUnique({ where: { id: billId } })
      expect(dbBill?.status).toBe('finalized')
      expect(dbBill?.subtotalMinor).toBe(20000n)

      // Writes the real audit_events row via platform/manager-auth, same
      // pattern as story 8's discount-above-threshold gate.
      const auditRow = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'refund' } })
      expect(auditRow).toMatchObject({ approverName: 'Meera Manager', reason: 'Customer sent both dishes back' })
    })

    it('supports a partial refund of one unit, with correct proportional tax reversal', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderLineId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000)

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        managerPin,
        reason: 'One dish was wrong',
        lines: [{ orderLineId, quantity: 1 }],
      })
      expect(res.status).toBe(201)
      const note = res.body as CreditNoteBody
      expect(note.subtotalMinor).toBe(10000)
      expect(note.taxMinor).toBe(500) // 5% of 10000
      expect(note.totalMinor).toBe(10500)
      expect(note.lines[0]).toMatchObject({ quantity: 1, amountMinor: 10000 })
    })

    it('rejects refunding more units than remain, across multiple credit notes', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderLineId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000) // quantity 2

      const first = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        managerPin,
        reason: 'First unit wrong',
        lines: [{ orderLineId, quantity: 1 }],
      })
      expect(first.status).toBe(201)

      // Only 1 remains refundable - asking for 2 more must be rejected, and
      // must not create a partial/short credit note as a side effect.
      const second = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        managerPin,
        reason: 'Trying to over-refund',
        lines: [{ orderLineId, quantity: 2 }],
      })
      expect(second.status).toBe(400)
      expect((second.body as ErrorBody).error.code).toBe('over_refund')

      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(1)
    })

    it('rejects a refund with no manager PIN, and with a wrong one - creating no CreditNote', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, cashierToken } = await setUpFinalizedBill(tenantId, outletId, 10000)

      const noPin = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        reason: 'No PIN given',
      })
      expect(noPin.status).toBe(400)

      const wrongPin = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        managerPin: '9999',
        reason: 'Wrong PIN',
      })
      expect(wrongPin.status).toBe(401)

      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
    })

    it('rejects a refund with no reason', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000)

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({ managerPin })
      expect(res.status).toBe(400)
    })

    it('rejects a refund against a still-open (non-finalized) Bill', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
      const managerPin = '1234'
      await createStaff(prisma, tenantId, outletId, 'Meera Manager', { isManager: true, pin: managerPin })
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)

      const opened = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()
      const orderId = (opened.body as { id: string }).id
      await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), owner.token).send({ itemId, quantity: 1 })
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), owner.token).send()
      const billId = (created.body as BillBody).id // never finalized

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), owner.token).send({
        managerPin,
        reason: 'Trying to refund an open bill',
      })
      expect(res.status).toBe(409)
      expect((res.body as ErrorBody).error.code).toBe('bill_not_finalized')

      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
    })

    it('enforces cross-tenant isolation - a bill from another tenant 404s, not a leaked refund', async () => {
      const tenantA = await createTenant(prisma, 'Tenant A')
      const outletA = await createOutlet(prisma, tenantA)
      const { billId } = await setUpFinalizedBill(tenantA, outletA, 10000)

      const tenantB = await createTenant(prisma, 'Tenant B')
      const outletB = await createOutlet(prisma, tenantB)
      const staffB = await createStaff(prisma, tenantB, outletB, 'Rahul')
      await createStaff(prisma, tenantB, outletB, 'Other Manager', { isManager: true, pin: '5555' })

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), staffB.token).send({
        managerPin: '5555',
        reason: 'Should not reach tenant A\'s bill',
      })
      expect(res.status).toBe(404)

      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
    })
  })
})
