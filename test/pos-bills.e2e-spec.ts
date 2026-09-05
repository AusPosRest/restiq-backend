// pos/CAP-7 success criteria, end to end (SPEC-pos-cashier-waiter, story 8):
//  - creating a bill from a real order's lines computes the correct
//    subtotal/tax
//  - finalising with a matching tender sum succeeds and is immutable after
//    (400/409 on a second finalise attempt)
//  - a mismatched tender sum is rejected
//  - a discount above the threshold without a valid manager PIN is rejected;
//    with one it succeeds and writes the audit row (platform/manager-auth's
//    real audit pattern)
//  - billNumber is gapless per outlet across multiple bills, including after
//    a rejected/failed finalise attempt
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
  createdAt: string
}
interface TaxBreakdownLineBody {
  label: string
  ratePercent: number
  amountMinor: number
}
interface BillBody {
  id: string
  tenantId: string
  outletId: string
  orderId: string
  billNumber: number | null
  subtotalMinor: number
  taxMinor: number
  taxBreakdown: TaxBreakdownLineBody[]
  pricesIncludeTax: boolean
  discountMinor: number | null
  discountReason: string | null
  totalMinor: number
  status: 'open' | 'finalized'
  createdByStaffId: string
  createdAt: string
  finalizedByStaffId: string | null
  finalizedAt: string | null
  tenders: TenderBody[]
}
interface OrderBody {
  id: string
  status: 'open' | 'sent' | 'closed'
}
interface InvoiceBody {
  invoiceNumber: string
  title: string
  issuedAt: string
  currency: string
  seller: {
    legalEntityName: string
    phone: string
    email: string
    registrationLabel: 'GSTIN' | 'ABN'
    registrationNumber: string
    fssaiLicense: string | null
    outletName: string
    outletAddress: string
  }
  footerMessage: string | null
  lines: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[]
  subtotalMinor: number
  discountMinor: number | null
  discountReason: string | null
  taxBreakdown: TaxBreakdownLineBody[]
  taxMinor: number
  totalMinor: number
  pricesIncludeTax: boolean
  tenders: TenderBody[]
  creditNotes: { id: string; amountMinor: number; reason: string; createdAt: string }[]
  notes: string[]
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
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

async function createAuTenant(prisma: PrismaClient, name = 'Sydney Harbour Bistro'): Promise<string> {
  const tenantId = uuidv7()
  await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name,
      registeredAddress: '1 Test Street, Sydney',
      contactName: 'Test Contact',
      contactEmail: 'contact@test.example',
      contactPhone: '+61 2 9000 0000',
      country: 'AU',
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  return tenantId
}

async function createTaxRegistration(
  prisma: PrismaClient,
  tenantId: string,
  opts: {
    taxProfile: string
    registrationType: 'gstin' | 'abn'
    compositionScheme?: boolean
    legalEntityName?: string
    fssaiLicense?: string
    gstRegistered?: boolean
  },
): Promise<void> {
  await prisma.tenantTaxRegistration.create({
    data: {
      tenantId,
      registrationType: opts.registrationType,
      registrationNumber: `REG-${uuidv7()}`,
      legalEntityName: opts.legalEntityName ?? 'Spice Route Hospitality Pvt Ltd',
      taxProfile: opts.taxProfile,
      compositionScheme: opts.compositionScheme ?? false,
      gstRegistered: opts.gstRegistered ?? true,
      fssaiLicense: opts.fssaiLicense ?? null,
    },
  })
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

describe('/pos/v1 bill and settle (e2e)', () => {
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

  /** Opens a table order, adds one line at priceMinor, sends it to the kitchen. Returns the order id and the owner's token. */
  async function setUpSentOrder(tenantId: string, outletId: string, priceMinor: number): Promise<{ orderId: string; ownerToken: string; ownerId: string }> {
    const tableId = await createTable(prisma, tenantId, outletId)
    const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
    const itemId = await createItemWithPrice(prisma, tenantId, priceMinor)

    const opened = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()
    const orderId = (opened.body as OrderBody).id
    await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), owner.token).send({ itemId, quantity: 2 })
    await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), owner.token).send({ status: 'sent' })

    return { orderId, ownerToken: owner.token, ownerId: owner.id }
  }

  describe('creating a bill', () => {
    it('computes subtotal and the placeholder tax from the order\'s real lines', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000) // 2 x 10000 = 20000 subtotal

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      expect(res.status).toBe(201)
      const bill = res.body as BillBody
      expect(bill.orderId).toBe(orderId)
      expect(bill.status).toBe('open')
      expect(bill.subtotalMinor).toBe(20000)
      expect(bill.taxMinor).toBe(1000) // 5% documented placeholder rate
      expect(bill.totalMinor).toBe(21000)
      expect(bill.billNumber).toBeNull()
    })

    it('rejects a non-owner creating a bill, naming the current owner', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId } = await setUpSentOrder(tenantId, outletId, 10000)
      const other = await createStaff(prisma, tenantId, outletId, 'Vikram')

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), other.token).send()
      expect(res.status).toBe(403)
    })

    it('is idempotent: a second POST for the same order returns 200 with the same bill id and writes no second row (issue #98)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)

      const first = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      expect(first.status).toBe(201)
      const firstBill = first.body as BillBody

      const second = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      expect(second.status).toBe(200)
      const secondBill = second.body as BillBody
      expect(secondBill.id).toBe(firstBill.id)
      expect(secondBill).toEqual(firstBill)

      const rows = await prisma.bill.findMany({ where: { orderId } })
      expect(rows).toHaveLength(1)
    })

    it('is safe under concurrent POST for the same order: one created, one returned from the existing row (same id)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)

      const [first, second] = await Promise.all([
        authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send(),
        authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send(),
      ])

      expect([first.status, second.status].sort()).toEqual([200, 201])
      const firstBill = first.body as BillBody
      const secondBill = second.body as BillBody
      expect(firstBill.id).toBe(secondBill.id)

      const rows = await prisma.bill.findMany({ where: { orderId } })
      expect(rows).toHaveLength(1)
    })

    it('returns a finalized bill with 200 (not 409) on a repeat POST', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect(finalized.status).toBe(200)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      expect(res.status).toBe(200)
      const bill = res.body as BillBody
      expect(bill.id).toBe(billId)
      expect(bill.status).toBe('finalized')
      expect(bill.tenders).toHaveLength(1)

      const rows = await prisma.bill.findMany({ where: { orderId } })
      expect(rows).toHaveLength(1)
    })

    it('rejects billing an order closed via a direct status transition with no bill ever created', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
      const opened = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()
      const orderId = (opened.body as OrderBody).id
      await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), owner.token).send({ status: 'sent' })
      await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), owner.token).send({ status: 'closed' })

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), owner.token).send()
      expect(res.status).toBe(409)
      expect((res.body as ErrorBody).error.code).toBe('conflict')

      const rows = await prisma.bill.findMany({ where: { orderId } })
      expect(rows).toHaveLength(0)
    })
  })

  describe('finalising a bill', () => {
    it('succeeds with a matching single tender, closes the order, and is immutable after (409 on a second finalise)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect(res.status).toBe(200)
      const bill = res.body as BillBody
      expect(bill.status).toBe('finalized')
      expect(bill.billNumber).toBe(1)
      expect(bill.tenders).toHaveLength(1)
      expect(bill.finalizedAt).not.toBeNull()

      const order = await authed(request(httpServer).get(`/pos/v1/orders/${orderId}`), ownerToken)
      expect((order.body as OrderBody).status).toBe('closed')

      const second = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect(second.status).toBe(409)
      expect((second.body as ErrorBody).error.code).toBe('already_finalized')
    })

    it('succeeds with a split multi-tender settlement summing to the total', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [
          { method: 'cash', amountMinor: 10000 },
          { method: 'upi_manual', amountMinor: 11000 },
        ],
      })
      expect(res.status).toBe(200)
      expect((res.body as BillBody).tenders).toHaveLength(2)
    })

    it('rejects a mismatched tender sum', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 19000 }],
      })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('tender_mismatch')

      const fetched = await authed(request(httpServer).get(`/pos/v1/bills/${billId}`), ownerToken)
      expect((fetched.body as BillBody).status).toBe('open')
    })

    describe('discount above threshold (platform/manager-auth, AD-15)', () => {
      it('rejects a discount above the threshold with no manager PIN, and with a wrong one', async () => {
        const tenantId = await createTenant(prisma)
        const outletId = await createOutlet(prisma, tenantId)
        const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000) // subtotal 20000, tax 1000, total 21000
        await createStaff(prisma, tenantId, outletId, 'Meera Manager', { isManager: true, pin: '1234' })
        const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
        const billId = (created.body as BillBody).id

        // 20% of subtotal (20000) is 4000 - 5000 clears the threshold.
        const noPin = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
          discountMinor: 5000,
          discountReason: 'Regular customer',
          tenders: [{ method: 'cash', amountMinor: 16000 }],
        })
        expect(noPin.status).toBe(400)
        expect((noPin.body as ErrorBody).error.code).toBe('manager_pin_required')

        const wrongPin = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
          discountMinor: 5000,
          discountReason: 'Regular customer',
          managerPin: '9999',
          tenders: [{ method: 'cash', amountMinor: 16000 }],
        })
        expect(wrongPin.status).toBe(401)

        expect(await prisma.bill.findUnique({ where: { id: billId } }).then((b) => b?.status)).toBe('open')
      })

      it('succeeds with a valid manager PIN, writing the audit_events row', async () => {
        const tenantId = await createTenant(prisma)
        const outletId = await createOutlet(prisma, tenantId)
        const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
        await createStaff(prisma, tenantId, outletId, 'Meera Manager', { isManager: true, pin: '1234' })
        const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
        const billId = (created.body as BillBody).id

        const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
          discountMinor: 5000,
          discountReason: 'Regular customer',
          managerPin: '1234',
          tenders: [{ method: 'cash', amountMinor: 16000 }],
        })
        expect(res.status).toBe(200)
        const bill = res.body as BillBody
        expect(bill.discountMinor).toBe(5000)
        expect(bill.totalMinor).toBe(16000)

        const auditRow = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'discount_above_threshold' } })
        expect(auditRow).toMatchObject({ approverName: 'Meera Manager', reason: 'Regular customer' })
      })

      it('allows a discount below the threshold with no manager PIN at all', async () => {
        const tenantId = await createTenant(prisma)
        const outletId = await createOutlet(prisma, tenantId)
        const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000) // subtotal 20000; 20% threshold = 4000
        const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
        const billId = (created.body as BillBody).id

        const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
          discountMinor: 1000,
          discountReason: 'Loyalty rounding',
          tenders: [{ method: 'cash', amountMinor: 20000 }],
        })
        expect(res.status).toBe(200)
        expect((res.body as BillBody).discountMinor).toBe(1000)
      })

      it('rejects a discountMinor given without a discountReason', async () => {
        const tenantId = await createTenant(prisma)
        const outletId = await createOutlet(prisma, tenantId)
        const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
        const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
        const billId = (created.body as BillBody).id

        const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
          discountMinor: 1000,
          tenders: [{ method: 'cash', amountMinor: 20000 }],
        })
        expect(res.status).toBe(400)
        expect((res.body as ErrorBody).error.code).toBe('validation_failed')
      })
    })
  })

  describe('gapless bill numbering per outlet (AD-14)', () => {
    it('numbers bills 1, 2, 3... with no gap even after a failed finalise attempt', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const first = await setUpSentOrder(tenantId, outletId, 10000)
      const firstBill = await authed(request(httpServer).post(`/pos/v1/orders/${first.orderId}/bill`), first.ownerToken).send()
      const firstBillId = (firstBill.body as BillBody).id

      // A finalise attempt that fails validation (tender mismatch) BEFORE the
      // gapless counter is ever touched - proves the failure leaves no gap.
      const failedAttempt = await authed(request(httpServer).post(`/pos/v1/bills/${firstBillId}/finalize`), first.ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 1 }],
      })
      expect(failedAttempt.status).toBe(400)

      const firstFinalized = await authed(request(httpServer).post(`/pos/v1/bills/${firstBillId}/finalize`), first.ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect(firstFinalized.status).toBe(200)
      expect((firstFinalized.body as BillBody).billNumber).toBe(1)

      const second = await setUpSentOrder(tenantId, outletId, 5000)
      const secondBill = await authed(request(httpServer).post(`/pos/v1/orders/${second.orderId}/bill`), second.ownerToken).send()
      const secondFinalized = await authed(request(httpServer).post(`/pos/v1/bills/${(secondBill.body as BillBody).id}/finalize`), second.ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 10500 }],
      })
      expect(secondFinalized.status).toBe(200)
      expect((secondFinalized.body as BillBody).billNumber).toBe(2)
    })

    it('numbers independently per outlet - a second outlet also starts at 1', async () => {
      const tenantId = await createTenant(prisma)
      const outletA = await createOutlet(prisma, tenantId, 'Outlet A')
      const outletB = await createOutlet(prisma, tenantId, 'Outlet B')

      const a = await setUpSentOrder(tenantId, outletA, 10000)
      const aBill = await authed(request(httpServer).post(`/pos/v1/orders/${a.orderId}/bill`), a.ownerToken).send()
      const aFinalized = await authed(request(httpServer).post(`/pos/v1/bills/${(aBill.body as BillBody).id}/finalize`), a.ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect((aFinalized.body as BillBody).billNumber).toBe(1)

      const b = await setUpSentOrder(tenantId, outletB, 10000)
      const bBill = await authed(request(httpServer).post(`/pos/v1/orders/${b.orderId}/bill`), b.ownerToken).send()
      const bFinalized = await authed(request(httpServer).post(`/pos/v1/bills/${(bBill.body as BillBody).id}/finalize`), b.ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect((bFinalized.body as BillBody).billNumber).toBe(1)
    })
  })

  describe('country-aware tax engine (issue #103)', () => {
    it('IN + CGST/SGST profile: splits 5% into CGST 2.5% + SGST 2.5%, summing to taxMinor', async () => {
      const tenantId = await createTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'India GST - CGST/SGST split', registrationType: 'gstin' })
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000) // 2 x 10000 = 20000 subtotal

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const bill = res.body as BillBody
      expect(bill.pricesIncludeTax).toBe(false)
      expect(bill.taxMinor).toBe(1000)
      expect(bill.taxBreakdown).toEqual([
        { label: 'CGST', ratePercent: 2.5, amountMinor: 500 },
        { label: 'SGST', ratePercent: 2.5, amountMinor: 500 },
      ])
      expect(bill.taxBreakdown.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(bill.taxMinor)
      expect(bill.totalMinor).toBe(21000)
    })

    it('IN + IGST profile: a single IGST 5% line', async () => {
      const tenantId = await createTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'Interstate supply - IGST', registrationType: 'gstin' })
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const bill = res.body as BillBody
      expect(bill.taxMinor).toBe(1000)
      expect(bill.taxBreakdown).toEqual([{ label: 'IGST', ratePercent: 5, amountMinor: 1000 }])
    })

    it('IN + compositionScheme: zero tax, empty breakdown', async () => {
      const tenantId = await createTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'India GST', registrationType: 'gstin', compositionScheme: true })
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const bill = res.body as BillBody
      expect(bill.taxMinor).toBe(0)
      expect(bill.taxBreakdown).toEqual([])
      expect(bill.totalMinor).toBe(bill.subtotalMinor)
    })

    it('AU: a single inclusive 10% GST line - subtotal already includes tax, so the total is just the subtotal', async () => {
      const tenantId = await createAuTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'Australia GST', registrationType: 'abn', legalEntityName: 'Sydney Harbour Bistro Pty Ltd' })
      const outletId = await createOutlet(prisma, tenantId, 'Darling Harbour')
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 5500) // 2 x 5500 = 11000 subtotal

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const bill = res.body as BillBody
      expect(bill.subtotalMinor).toBe(11000)
      expect(bill.pricesIncludeTax).toBe(true)
      expect(bill.taxMinor).toBe(1000) // 11000 - round(11000 * 10 / 11)
      expect(bill.taxBreakdown).toEqual([{ label: 'GST', ratePercent: 10, amountMinor: 1000 }])
      expect(bill.totalMinor).toBe(11000)
    })

    it('AU + not GST-registered: zero tax, no GST-inclusive total math, title should be "Receipt" on invoice', async () => {
      const tenantId = await createAuTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'Australia GST', registrationType: 'abn', gstRegistered: false })
      const outletId = await createOutlet(prisma, tenantId, 'Darling Harbour')
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 5500) // 2 x 5500 = 11000 subtotal

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const bill = res.body as BillBody
      expect(bill.subtotalMinor).toBe(11000)
      expect(bill.pricesIncludeTax).toBe(false)
      expect(bill.taxMinor).toBe(0)
      expect(bill.taxBreakdown).toEqual([])
      expect(bill.totalMinor).toBe(11000)
    })
  })

  describe('GET /pos/v1/bills/:id/invoice (issue #103)', () => {
    it('409s before finalize, 200s after with the exact InvoiceView shape and real tenders', async () => {
      const tenantId = await createTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'India GST - CGST/SGST split', registrationType: 'gstin', legalEntityName: 'Spice Route Hospitality Pvt Ltd' })
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const beforeFinalize = await authed(request(httpServer).get(`/pos/v1/bills/${billId}/invoice`), ownerToken)
      expect(beforeFinalize.status).toBe(409)
      expect((beforeFinalize.body as ErrorBody).error.code).toBe('not_finalized')

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect(finalized.status).toBe(200)

      const res = await authed(request(httpServer).get(`/pos/v1/bills/${billId}/invoice`), ownerToken)
      expect(res.status).toBe(200)
      const invoice = res.body as InvoiceBody
      expect(invoice.footerMessage).toBeNull()
      expect(invoice.invoiceNumber).toBe(String((finalized.body as BillBody).billNumber))
      expect(invoice.title).toBe('Invoice')
      expect(invoice.currency).toBe('INR')
      expect(invoice.seller).toMatchObject({
        legalEntityName: 'Spice Route Hospitality Pvt Ltd',
        phone: '+91 90000 00000',
        email: 'contact@test.example',
        registrationLabel: 'GSTIN',
        outletName: 'Indiranagar',
        outletAddress: 'A1',
      })
      expect(invoice.lines).toEqual([{ name: expect.any(String) as string, quantity: 2, unitPriceMinor: 10000, lineTotalMinor: 20000 }])
      expect(invoice.subtotalMinor).toBe(20000)
      expect(invoice.taxMinor).toBe(1000)
      expect(invoice.taxBreakdown.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(invoice.taxMinor)
      expect(invoice.totalMinor).toBe(21000)
      expect(invoice.pricesIncludeTax).toBe(false)
      expect(invoice.tenders).toEqual([{ id: expect.any(String) as string, method: 'cash', amountMinor: 21000, createdAt: expect.any(String) as string }])
      expect(invoice.creditNotes).toEqual([])
      expect(invoice.notes).toEqual([])
    })

    it('AU: an inclusive-GST bill invoices with title "Tax Invoice"', async () => {
      const tenantId = await createAuTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'Australia GST', registrationType: 'abn' })
      const outletId = await createOutlet(prisma, tenantId, 'Darling Harbour')
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 5500)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 11000 }],
      })
      expect(finalized.status).toBe(200)

      const res = await authed(request(httpServer).get(`/pos/v1/bills/${billId}/invoice`), ownerToken)
      expect(res.status).toBe(200)
      const invoice = res.body as InvoiceBody
      expect(invoice.title).toBe('Tax Invoice')
      expect(invoice.currency).toBe('AUD')
      expect(invoice.seller.registrationLabel).toBe('ABN')
      expect(invoice.pricesIncludeTax).toBe(true)
      expect(invoice.totalMinor).toBe(11000)
    })

    it('AU: unregistered tenant invoices with title "Receipt", zero tax, and no total uplift', async () => {
      const tenantId = await createAuTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'Australia GST', registrationType: 'abn', gstRegistered: false })
      await prisma.tenant.update({ where: { id: tenantId }, data: { brandingTokens: { receiptFooter: 'Tax-free receipt footer' } } })
      const outletId = await createOutlet(prisma, tenantId, 'Darling Harbour')
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 5500) // 2 x 5500 = 11000 subtotal
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 11000 }],
      })
      expect(finalized.status).toBe(200)

      const res = await authed(request(httpServer).get(`/pos/v1/bills/${billId}/invoice`), ownerToken)
      expect(res.status).toBe(200)
      const invoice = res.body as InvoiceBody
      expect(invoice.title).toBe('Receipt')
      expect(invoice.footerMessage).toBe('Tax-free receipt footer')
      expect(invoice.currency).toBe('AUD')
      expect(invoice.seller.phone).toBe('+61 2 9000 0000')
      expect(invoice.seller.email).toBe('contact@test.example')
      expect(invoice.taxMinor).toBe(0)
      expect(invoice.taxBreakdown).toEqual([])
      expect(invoice.notes).toEqual(['Not registered for GST - this is a receipt, not a tax invoice'])
      expect(invoice.totalMinor).toBe(11000)
    })

    it('composition tenant: the statutory note carries through to the invoice', async () => {
      const tenantId = await createTenant(prisma)
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'India GST', registrationType: 'gstin', compositionScheme: true })
      const outletId = await createOutlet(prisma, tenantId)
      const { orderId, ownerToken } = await setUpSentOrder(tenantId, outletId, 10000)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 20000 }],
      })
      expect(finalized.status).toBe(200)

      const res = await authed(request(httpServer).get(`/pos/v1/bills/${billId}/invoice`), ownerToken)
      expect(res.status).toBe(200)
      const invoice = res.body as InvoiceBody
      expect(invoice.taxMinor).toBe(0)
      expect(invoice.taxBreakdown).toEqual([])
      expect(invoice.notes).toEqual(['Composition taxable person, not eligible to collect tax on supplies'])
    })

    it('enforces cross-tenant isolation - a bill from another tenant 404s, not a leaked invoice', async () => {
      const tenantA = await createTenant(prisma, 'Tenant A')
      const outletA = await createOutlet(prisma, tenantA)
      const { orderId, ownerToken } = await setUpSentOrder(tenantA, outletA, 10000)
      const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), ownerToken).send()
      const billId = (created.body as BillBody).id
      await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), ownerToken).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })

      const tenantB = await createTenant(prisma, 'Tenant B')
      const outletB = await createOutlet(prisma, tenantB)
      const otherStaff = await createStaff(prisma, tenantB, outletB, 'Other Staff')

      const res = await authed(request(httpServer).get(`/pos/v1/bills/${billId}/invoice`), otherStaff.token)
      expect(res.status).toBe(404)
    })
  })
})
