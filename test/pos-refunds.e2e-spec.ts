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
  pricesIncludeTax: boolean
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
  method: string | null
  createdAt: string
  lines: CreditNoteLineBody[]
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
  await prisma.paymentIntent.deleteMany()
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
  await prisma.comboSlotOption.deleteMany()
  await prisma.comboSlot.deleteMany()
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
  await prisma.cashMovement.deleteMany()
  await prisma.shift.deleteMany()
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
  await prisma.tokenNumberCounter.deleteMany()
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

async function createTenant(prisma: PrismaClient, name = 'Spice Route Hospitality', country: 'IN' | 'AU' = 'IN'): Promise<string> {
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
      country,
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
  const role = await prisma.role.upsert({ where: { tenantId_name: { tenantId, name: opts?.isManager ? 'Manager' : 'Cashier' } }, update: {}, create: { tenantId, name: opts?.isManager ? 'Manager' : 'Cashier', isSystem: true, isManager: opts?.isManager ?? false } })
  const pinHash = opts?.pin ? await argon2.hash(opts.pin) : undefined
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name, pinHash } })
  // restiq-backend#208 (PE-17): cash needs an open shift at the outlet - the
  // first staff member created for an outlet opens one.
  if (!(await prisma.shift.findFirst({ where: { outletId, closedAt: null } }))) {
    await prisma.shift.create({ data: { tenantId, outletId, openedByStaffId: staff.id, floatMinor: 0n } })
  }
  const token = signPosToken({ sessionVersion: 0, id: staff.id, tenantId, outletId, name })
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
    // Leave no shifts behind (PE-17 fixtures open them): other spec files'
    // wipe() helpers predate them and would trip their FK on staff_users.
    await wipe(prisma)
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
    opts: { quantity?: number; discountMinor?: number; secondItemPriceMinor?: number; counter?: boolean; tenders?: (totalMinor: number) => { method: string; amountMinor: number }[] } = {},
  ): Promise<{ billId: string; orderId: string; orderLineId: string; cashierToken: string; managerPin: string; bill: BillBody }> {
    const owner = await createStaff(prisma, tenantId, outletId, 'Asha', { isManager: true }) // #209: refunding needs the Refunds permission
    const managerPin = '1234'
    await createStaff(prisma, tenantId, outletId, 'Meera Manager', { isManager: true, pin: managerPin })
    const itemId = await createItemWithPrice(prisma, tenantId, priceMinor)

    // A pay-first counter order is sent to the kitchen by finalize itself.
    const opened = opts.counter
      ? await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/counter-orders`), owner.token).send()
      : await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${await createTable(prisma, tenantId, outletId)}/order`), owner.token).send()
    const orderId = (opened.body as { id: string }).id
    await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), owner.token).send({ itemId, quantity: opts.quantity ?? 2 })
    if (opts.secondItemPriceMinor) {
      const secondItemId = await createItemWithPrice(prisma, tenantId, opts.secondItemPriceMinor)
      await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), owner.token).send({ itemId: secondItemId, quantity: 1 })
    }
    if (!opts.counter) await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), owner.token).send({ status: 'sent' })

    const orderRes = await authed(request(httpServer).get(`/pos/v1/orders/${orderId}`), owner.token)
    const orderLineId = (orderRes.body as OrderBody).lines[0].id

    const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), owner.token).send()
    const billId = (created.body as BillBody).id
    // IN, no tax registration: 5% GST rounded once on the discounted value
    // (SE-2, #244) - mirrored here so the tender matches exactly. AU GST is
    // inside the price, so the net is what is paid.
    const netMinor = (created.body as BillBody).subtotalMinor - (opts.discountMinor ?? 0)
    const totalMinor = (created.body as BillBody).pricesIncludeTax ? netMinor : netMinor + Math.round((netMinor * 5) / 100)

    const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), owner.token).send({
      ...(opts.discountMinor && { discountMinor: opts.discountMinor, discountReason: 'Regular customer' }),
      tenders: opts.tenders ? opts.tenders(totalMinor) : [{ method: 'cash', amountMinor: totalMinor }],
    })
    expect(finalized.status).toBe(200)

    return { billId, orderId, orderLineId, cashierToken: owner.token, managerPin, bill: finalized.body as BillBody }
  }

  describe('manager override (#240)', () => {
    it.each([
      ['manager', '1234', 201, undefined],
      ['assigned outlet', '1234', 201, undefined],
      ['permission without manager flag', '1234', 201, undefined],
      ['missing', undefined, 403, 'forbidden'],
      ['cashier', '5678', 401, 'invalid_credentials'],
      ['wrong', '9999', 401, 'invalid_credentials'],
      ['revoked', '1234', 401, 'invalid_credentials'],
      ['other outlet', '1234', 401, 'invalid_credentials'],
      ['other tenant', '7777', 401, 'invalid_credentials'],
    ])('cashier refund with %s PIN', async (kind, managerPin, status, code) => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId } = await setUpFinalizedBill(tenantId, outletId, 10000)
      const cashier = await createStaff(prisma, tenantId, outletId, 'Cashier', { pin: '5678' })
      const manager = await prisma.staffUser.findFirstOrThrow({ where: { tenantId, name: 'Meera Manager' } })
      if (kind === 'assigned outlet') await prisma.staffUser.update({ where: { id: manager.id }, data: { outletIds: [outletId] } })
      if (kind === 'permission without manager flag') await prisma.role.update({ where: { id: manager.roleId }, data: { isManager: false } })
      if (kind === 'revoked') await prisma.staffUser.update({ where: { id: manager.id }, data: { pinRevokedAt: new Date() } })
      if (kind === 'other outlet') {
        const otherOutlet = await createOutlet(prisma, tenantId, 'Other outlet')
        await prisma.staffUser.update({ where: { id: manager.id }, data: { outletIds: [otherOutlet] } })
      }
      if (kind === 'other tenant') {
        const otherTenant = await createTenant(prisma, 'Other tenant')
        const otherOutlet = await createOutlet(prisma, otherTenant)
        await createStaff(prisma, otherTenant, otherOutlet, 'Other manager', { isManager: true, pin: '7777' })
      }
      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashier.token).send({ managerPin, reason: 'Customer returned dishes' })
      expect(res.status).toBe(status)
      if (status === 201) {
        expect(res.body).toMatchObject({ approvedByStaffId: manager.id, createdByStaffId: cashier.id })
        expect(await prisma.auditEvent.findFirst({ where: { tenantId, action: 'refund' } })).toMatchObject({ approverId: manager.id, actorId: cashier.id })
      } else {
        expect((res.body as ErrorBody).error.code).toBe(code)
        expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
        expect(await prisma.auditEvent.count({ where: { tenantId, action: 'refund' } })).toBe(0)
      }
    })

    it('counts unqualified PIN guesses toward the attempt limit', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId } = await setUpFinalizedBill(tenantId, outletId, 10000)
      const cashier = await createStaff(prisma, tenantId, outletId, 'Cashier', { pin: '5678' })
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashier.token).send({ managerPin: '5678', reason: 'Returned dishes' })
        expect(res.status).toBe(401)
        expect((res.body as ErrorBody).error.code).toBe('invalid_credentials')
      }
      const blocked = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashier.token).send({ managerPin: '1234', reason: 'Returned dishes' })
      expect(blocked.status).toBe(429)
      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'refund' } })).toBe(0)
    })

    it('approves a shared waiter and manager PIN using the qualified manager', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Waiter', { pin: '1234' })
      const waiterRole = await prisma.role.create({ data: { tenantId, name: 'Waiter' } })
      await prisma.staffUser.update({ where: { id: waiter.id }, data: { roleId: waiterRole.id } })
      const { billId } = await setUpFinalizedBill(tenantId, outletId, 10000)
      const cashier = await createStaff(prisma, tenantId, outletId, 'Cashier')
      const manager = await prisma.staffUser.findFirstOrThrow({ where: { tenantId, name: 'Meera Manager' } })
      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashier.token).send({ managerPin: '1234', reason: 'Returned dishes' })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ approvedByStaffId: manager.id, createdByStaffId: cashier.id })
      expect(await prisma.auditEvent.findFirst({ where: { tenantId, action: 'refund' } })).toMatchObject({ approverId: manager.id, actorId: cashier.id })
    })

    it('rejects an isManager role without the refunds permission', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId } = await setUpFinalizedBill(tenantId, outletId, 10000)
      const cashier = await createStaff(prisma, tenantId, outletId, 'Cashier')
      const role = await prisma.role.create({ data: { tenantId, name: 'Custom manager', isManager: true } })
      await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Custom manager', pinHash: await argon2.hash('5678') } })
      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashier.token).send({ managerPin: '5678', reason: 'Returned dishes' })
      expect(res.status).toBe(401)
      expect((res.body as ErrorBody).error.code).toBe('invalid_credentials')
      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
    })
  })

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

    it('a full refund of a discounted bill returns exactly what was paid (SE-1)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      // 2 x 10000 = 20000, discount 4000 -> taxable 16000, tax 800, paid 16800.
      const { billId, cashierToken, managerPin, bill } = await setUpFinalizedBill(tenantId, outletId, 10000, { discountMinor: 4000 })
      expect(bill.totalMinor).toBe(16800)

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({ managerPin, reason: 'Full refund' })
      expect(res.status).toBe(201)
      const note = res.body as CreditNoteBody
      expect(note).toMatchObject({ subtotalMinor: 16000, taxMinor: 800, totalMinor: 16800 })
      const paid = await prisma.tender.aggregate({ where: { billId }, _sum: { amountMinor: true } })
      expect(BigInt(note.totalMinor)).toBe(paid._sum.amountMinor)
    })

    it('partial refunds are pro-rated by the bill discount and add up to exactly what was paid (SE-1)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      // 3 x 3333 = 9999, discount 1000 -> taxable 8999, tax 225 + 225, paid 9449.
      const { billId, orderLineId, cashierToken, managerPin, bill } = await setUpFinalizedBill(tenantId, outletId, 3333, { quantity: 3, discountMinor: 1000 })
      expect(bill.totalMinor).toBe(9449)

      const totals: number[] = []
      for (let i = 0; i < 3; i++) {
        const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
          managerPin,
          reason: `Unit ${i + 1}`,
          lines: [{ orderLineId, quantity: 1 }],
        })
        expect(res.status).toBe(201)
        totals.push((res.body as CreditNoteBody).totalMinor)
      }
      expect(totals).toEqual([3149, 3150, 3150])
      expect(totals.reduce((a, b) => a + b, 0)).toBe(9449)
    })

    it('credit-note lines on a discounted bill are net of the discount and add up to the subtotal (restiq-backend#221)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      // 1 x 10000 + 1 x 3333 = 13333, discount 1000 -> net 12333.
      const { billId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000, { quantity: 1, discountMinor: 1000, secondItemPriceMinor: 3333 })

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({ managerPin, reason: 'Full refund' })
      expect(res.status).toBe(201)
      const note = res.body as CreditNoteBody
      expect(note.subtotalMinor).toBe(12333)
      expect(note.lines.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(12333)
      // Each line carries its own share: 10000 -> 9249 (rounded down), 3333 -> the 3084 remainder.
      expect(note.lines.map((l) => [l.unitPriceMinor, l.amountMinor]).sort((a, b) => b[0] - a[0])).toEqual([
        [10000, 9249],
        [3333, 3084],
      ])
    })

    it('records how the money went back, defaulting to the bill\'s largest tender (restiq-backend#221)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderLineId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000, {
        tenders: (total) => [
          { method: 'cash', amountMinor: 5000 },
          { method: 'upi_manual', amountMinor: total - 5000 },
        ],
      })

      const defaulted = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({ managerPin, reason: 'Wrong dish', lines: [{ orderLineId, quantity: 1 }] })
      expect(defaulted.status).toBe(201)
      expect((defaulted.body as CreditNoteBody).method).toBe('upi_manual')

      const chosen = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({ managerPin, reason: 'Wrong dish', lines: [{ orderLineId, quantity: 1 }], method: 'cash' })
      expect(chosen.status).toBe(201)
      expect((chosen.body as CreditNoteBody).method).toBe('cash')
      expect((await prisma.creditNote.findMany({ where: { originalBillId: billId }, orderBy: { createdAt: 'asc' } })).map((n) => n.method)).toEqual(['upi_manual', 'cash'])

      const invoice = await authed(request(httpServer).get(`/pos/v1/bills/${billId}/invoice`), cashierToken)
      expect((invoice.body as { creditNotes: { method: string | null }[] }).creditNotes.map((n) => n.method)).toEqual(['upi_manual', 'cash'])
    })

    it('rejects a refund method that is not a tender method (restiq-backend#221)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000)

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({ managerPin, reason: 'Refund', method: 'cheque' })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('validation_failed')
      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
    })

    it('rejects the same order line named more than once past its quantity (SE-3)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderLineId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000) // quantity 2

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        managerPin,
        reason: 'Duplicate lines',
        lines: [
          { orderLineId, quantity: 2 },
          { orderLineId, quantity: 2 },
        ],
      })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('over_refund')
      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
    })

    it('concurrent whole-bill refunds refund the bill once (SE-4)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000)

      const refund = (i: number) => authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({ managerPin, reason: `Tap ${i}` })
      const results = await Promise.all([1, 2, 3, 4].map(refund))
      expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400, 400])
      for (const r of results.filter((x) => x.status === 400)) expect((r.body as ErrorBody).error.code).toBe('nothing_to_refund')
      const notes = await prisma.creditNote.findMany({ where: { originalBillId: billId } })
      expect(notes).toHaveLength(1)
      expect(notes[0].subtotalMinor + notes[0].taxMinor).toBe(21000n)
    })

    it('preserves manager behavior: no PIN is 400, wrong PIN is 401, creating no CreditNote', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, cashierToken } = await setUpFinalizedBill(tenantId, outletId, 10000)

      const noPin = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), cashierToken).send({
        reason: 'No PIN given',
      })
      expect(noPin.status).toBe(400)
      expect((noPin.body as ErrorBody).error.code).toBe('validation_failed')

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
      const owner = await createStaff(prisma, tenantId, outletId, 'Asha', { isManager: true }) // #209: refunding needs the Refunds permission
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
      const staffB = await createStaff(prisma, tenantB, outletB, 'Rahul', { isManager: true })
      await createStaff(prisma, tenantB, outletB, 'Other Manager', { isManager: true, pin: '5555' })

      const res = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), staffB.token).send({
        managerPin: '5555',
        reason: 'Should not reach tenant A\'s bill',
      })
      expect(res.status).toBe(404)

      expect(await prisma.creditNote.count({ where: { originalBillId: billId } })).toBe(0)
    })
  })

  // restiq-backend#259 (AP-se-8): a dish refunded in full is struck through on the kitchen screens.
  describe('kitchen after a refund (AP-se-8)', () => {
    interface QueueTicketBody {
      id: string
      orderId: string
      status: 'queued' | 'bumped'
      lines: { orderLineId: string; voided: boolean }[]
    }
    const queue = async (outletId: string, token: string) =>
      (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/unrouted/queue`), token).expect(200)).body as QueueTicketBody[]
    const expoOrderIds = async (outletId: string, token: string) =>
      ((await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/expo`), token).expect(200)).body as { orderId: string }[]).map((o) => o.orderId)
    const refund = async (billId: string, token: string, managerPin: string, lines?: { orderLineId: string; quantity: number }[]) =>
      authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), token).send({ managerPin, reason: 'Guest left', ...(lines && { lines }) }).expect(201)

    it('a full refund of a paid counter order voids its queued ticket lines and drops it from expo', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000, { counter: true })
      expect(await expoOrderIds(outletId, cashierToken)).toEqual([orderId])

      await refund(billId, cashierToken, managerPin)

      // Still on the station queue (the cook bumps it away), every line struck through.
      const tickets = await queue(outletId, cashierToken)
      expect(tickets.map((t) => t.orderId)).toEqual([orderId])
      expect(tickets[0].lines.length).toBeGreaterThan(0)
      expect(tickets[0].lines.every((l) => l.voided)).toBe(true)
      expect(await expoOrderIds(outletId, cashierToken)).toEqual([])
    })

    it('a refund of 1 of 2 units leaves the line cooking; refunding the other unit voids it', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderId, orderLineId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000, { counter: true })

      await refund(billId, cashierToken, managerPin, [{ orderLineId, quantity: 1 }])
      expect((await queue(outletId, cashierToken))[0].lines).toEqual([expect.objectContaining({ orderLineId, voided: false })])
      expect(await expoOrderIds(outletId, cashierToken)).toEqual([orderId])

      await refund(billId, cashierToken, managerPin, [{ orderLineId, quantity: 1 }])
      expect((await queue(outletId, cashierToken))[0].lines).toEqual([expect.objectContaining({ orderLineId, voided: true })])
      expect(await expoOrderIds(outletId, cashierToken)).toEqual([])
    })

    it('a refund after the ticket was bumped leaves the finished ticket alone', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, orderId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000, { counter: true })
      const [ticket] = await queue(outletId, cashierToken)
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket.id}/bump`), cashierToken).send().expect(200)

      await refund(billId, cashierToken, managerPin)

      const lines = await prisma.ticketLine.findMany({ where: { ticket: { orderId } } })
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.every((l) => !l.voided)).toBe(true)
    })
  })

  // restiq-backend#259 (AP-se-22): GST on an AU (tax-inclusive) refund is 1/11 of the money going back.
  describe('AU GST refunds (AP-se-22)', () => {
    async function auBill(opts: Parameters<typeof setUpFinalizedBill>[3]) {
      const tenantId = await createTenant(prisma, 'Sydney Harbour Bistro', 'AU')
      const outletId = await createOutlet(prisma, tenantId)
      const set = await setUpFinalizedBill(tenantId, outletId, opts?.quantity === 3 ? 335 : 495, opts)
      return { tenantId, ...set }
    }
    const lineOf = async (orderId: string, unitPriceMinor: bigint) => (await prisma.orderLine.findFirstOrThrow({ where: { orderId, unitPriceMinor } })).id
    const refundNote = async (billId: string, token: string, managerPin: string, lines?: { orderLineId: string; quantity: number }[]) =>
      (await authed(request(httpServer).post(`/pos/v1/bills/${billId}/refund`), token).send({ managerPin, reason: 'Refund', ...(lines && { lines }) }).expect(201)).body as CreditNoteBody

    it('refunding A$4.95 of an A$9.95 bill takes 45c GST (1/11), not 44c, and the rest takes the remainder', async () => {
      const { billId, orderId, cashierToken, managerPin, bill } = await auBill({ quantity: 1, secondItemPriceMinor: 500 })
      expect(bill).toMatchObject({ subtotalMinor: 995, taxMinor: 90, totalMinor: 995 })

      const first = await refundNote(billId, cashierToken, managerPin, [{ orderLineId: await lineOf(orderId, 495n), quantity: 1 }])
      expect(first).toMatchObject({ subtotalMinor: 495, taxMinor: 45, totalMinor: 495 })
      const rest = await refundNote(billId, cashierToken, managerPin)
      expect(rest).toMatchObject({ subtotalMinor: 500, taxMinor: 45, totalMinor: 500 })
    })

    it('a whole-bill refund in one note returns exactly the bill tax', async () => {
      const { billId, cashierToken, managerPin } = await auBill({ quantity: 1, secondItemPriceMinor: 500 })
      expect(await refundNote(billId, cashierToken, managerPin)).toMatchObject({ subtotalMinor: 995, taxMinor: 90, totalMinor: 995 })
    })

    it('unit-by-unit refunds never go negative or past the bill tax, and add up to it exactly', async () => {
      // 3 x 335 = 1005, GST 91.
      const { billId, orderLineId, cashierToken, managerPin, bill } = await auBill({ quantity: 3 })
      expect(bill).toMatchObject({ totalMinor: 1005, taxMinor: 91 })
      const notes: CreditNoteBody[] = []
      for (let i = 0; i < 3; i++) {
        notes.push(await refundNote(billId, cashierToken, managerPin, [{ orderLineId, quantity: 1 }]))
        expect(notes[i].taxMinor).toBeGreaterThanOrEqual(0)
        expect(notes.reduce((sum, n) => sum + n.taxMinor, 0)).toBeLessThanOrEqual(91)
      }
      expect(notes.map((n) => n.taxMinor)).toEqual([30, 31, 30])
      expect(notes.reduce((sum, n) => sum + n.totalMinor, 0)).toBe(1005)
    })

    it('a discounted bill refunds exactly what was paid and exactly the bill tax', async () => {
      // 995 less 100 discount = 895 paid, GST 81.
      const { billId, orderId, cashierToken, managerPin, bill } = await auBill({ quantity: 1, secondItemPriceMinor: 500, discountMinor: 100 })
      expect(bill).toMatchObject({ totalMinor: 895, taxMinor: 81 })

      const first = await refundNote(billId, cashierToken, managerPin, [{ orderLineId: await lineOf(orderId, 495n), quantity: 1 }])
      const rest = await refundNote(billId, cashierToken, managerPin)
      expect([first.taxMinor, rest.taxMinor]).toEqual([40, 41]) // 445 back -> 40.45, rounded half up to 40
      expect(first.totalMinor + rest.totalMinor).toBe(895)
    })

    it('uses the rate the bill was taxed at, not a rate the tenant changed to later', async () => {
      const { tenantId, billId, orderId, cashierToken, managerPin } = await auBill({ quantity: 1, secondItemPriceMinor: 500 })
      await prisma.tenantTaxRegistration.create({
        data: { tenantId, registrationType: 'abn', registrationNumber: `REG-${uuidv7()}`, legalEntityName: 'Bistro Pty Ltd', taxProfile: 'Australia GST', gstRatePercent: 20 },
      })
      const first = await refundNote(billId, cashierToken, managerPin, [{ orderLineId: await lineOf(orderId, 495n), quantity: 1 }])
      const rest = await refundNote(billId, cashierToken, managerPin)
      expect([first.taxMinor, rest.taxMinor]).toEqual([45, 45])
    })

    it.each([
      ['IN composition', 'IN' as const, { taxProfile: 'India GST', registrationType: 'gstin' as const, compositionScheme: true }],
      ['AU not registered for GST', 'AU' as const, { taxProfile: 'Australia GST', registrationType: 'abn' as const, gstRegistered: false }],
    ])('%s: refunds carry no tax', async (_label, country, registration) => {
      const tenantId = await createTenant(prisma, 'No Tax Cafe', country)
      await prisma.tenantTaxRegistration.create({ data: { tenantId, registrationNumber: `REG-${uuidv7()}`, legalEntityName: 'No Tax Cafe', ...registration } })
      const outletId = await createOutlet(prisma, tenantId)
      const { billId, cashierToken, managerPin } = await setUpFinalizedBill(tenantId, outletId, 10000, { quantity: 1, tenders: () => [{ method: 'cash', amountMinor: 10000 }] })
      expect(await refundNote(billId, cashierToken, managerPin)).toMatchObject({ subtotalMinor: 10000, taxMinor: 0, totalMinor: 10000 })
    })
  })
})
