// restiq-backend#227 (G2): bill row locking under concurrency
//  - two parallel payShare for the last share -> exactly one tender set and bill finalized once
//  - parallel identical payShare -> no double tender (share_already_paid)
//  - two parallel payShare for distinct shares -> both recorded and bill finalized once
//  - confirmIntent racing a cash finalize -> no second tender on finalized bill
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}

interface ShareBody {
  guestId: string
  guestName: string
  amountMinor: number
  status: 'outstanding' | 'paid'
  payerPhone: string | null
  paidAt: string | null
}

interface BillBody {
  id: string
  orderId: string
  billNumber: number | null
  subtotalMinor: number
  taxMinor: number
  totalMinor: number
  status: 'open' | 'finalized'
  createdByStaffId: string | null
  tenders: { id: string; method: string; amountMinor: number }[]
  shares: ShareBody[]
}

interface OrderBody {
  id: string
}

interface PlacedOrderBody {
  orderId: string
}

interface StartResult {
  token: string
  pin: string
  session: { sessionId: string }
}

interface JoinResult {
  token: string
  session: { sessionId: string }
}

interface IntentBody {
  id: string
  billId: string
  status: string
  amountMinor: number
  tenderId: string | null
  failureReason: string | null
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.billShare.deleteMany()
  await prisma.tender.deleteMany()
  await prisma.paymentIntent.deleteMany()
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
  await prisma.shift.deleteMany()
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

async function createTenant(prisma: PrismaClient, name = 'Spice Route Concurrency'): Promise<string> {
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

async function enableQrOrdering(prisma: PrismaClient, tenantId: string, outletId: string): Promise<void> {
  await prisma.outletCapability.upsert({
    where: { outletId_key: { outletId, key: 'qr_ordering' } },
    create: { tenantId, outletId, key: 'qr_ordering', enabled: true },
    update: { enabled: true },
  })
}

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId, name: 'Cashier' } },
    update: {},
    create: { tenantId, name: 'Cashier', isSystem: true, isManager: false },
  })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  if (!(await prisma.shift.findFirst({ where: { outletId, closedAt: null } }))) {
    await prisma.shift.create({ data: { tenantId, outletId, openedByStaffId: staff.id, floatMinor: 0n } })
  }
  const token = signPosToken({ sessionVersion: 0, id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm', available: true } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR' } })
  return item.id
}

describe('bill concurrency & row locking (restiq-backend#227, G2)', () => {
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

  async function placeOrderForGuests(
    outletId: string,
    tableId: string,
    itemId: string,
    guestCount: number,
  ): Promise<{ tokens: string[]; sessionId: string; orderId: string }> {
    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Guest 1', phone: '+91 90000 00001' })
    const { token: firstToken, pin, session } = startRes.body as StartResult
    const tokens = [firstToken]

    for (let i = 2; i <= guestCount; i++) {
      const joinRes = await request(httpServer)
        .post('/guest/v1/sessions/join')
        .send({ outletId, tableId, pin, name: `Guest ${i}` })
      tokens.push((joinRes.body as JoinResult).token)
    }

    for (const token of tokens) {
      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId, quantity: 1 })
      expect(res.status).toBe(201)
    }

    const placed = await authed(request(httpServer).post('/guest/v1/orders'), tokens[0]).send({})
    expect(placed.status).toBe(201)
    return { tokens, sessionId: session.sessionId, orderId: (placed.body as PlacedOrderBody).orderId }
  }

  describe('guest payShare concurrency', () => {
    it('two parallel payShare for the last share -> exactly one tender set and bill finalized once', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)

      const { tokens, sessionId, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 2)
      const billRes = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      expect(billRes.status).toBe(201)
      const bill = billRes.body as BillBody
      expect(bill.shares).toHaveLength(2)

      const guest1Id = bill.shares[0].guestId
      const guest2Id = bill.shares[1].guestId

      // Guest 1 pays their share successfully.
      const g1Pay = await authed(
        request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guest1Id}/pay`),
        tokens[0],
      ).send({ simulatedOutcome: 'success', payerPhone: '+91 90000 00001' })
      expect(g1Pay.status).toBe(200)
      expect((g1Pay.body as BillBody).status).toBe('open')
      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(1)

      // Now Guest 2's share is the last outstanding share.
      // Two concurrent calls race to pay the last share.
      const payLastShare = () =>
        authed(
          request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guest2Id}/pay`),
          tokens[1],
        ).send({ simulatedOutcome: 'success', payerPhone: '+91 90000 00002' })

      const [resA, resB] = await Promise.all([payLastShare(), payLastShare()])
      const statuses = [resA.status, resB.status].sort()
      expect(statuses).toEqual([200, 409])

      const failedRes = [resA, resB].find((r) => r.status === 409)!
      const errCode = (failedRes.body as ErrorBody).error.code
      expect(['already_finalized', 'share_already_paid']).toContain(errCode)

      // Exactly two tenders in total on the bill (one for guest 1, one for guest 2).
      const tenders = await prisma.tender.findMany({ where: { billId: bill.id } })
      expect(tenders).toHaveLength(2)

      // Bill finalized exactly once.
      const billRow = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })
      expect(billRow.status).toBe('finalized')
      expect(billRow.billNumber).toBe(1)

      // Order closed and table session settled.
      const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
      expect(orderRow.status).toBe('closed')
      const sessionRow = await prisma.tableSession.findUniqueOrThrow({ where: { id: sessionId } })
      expect(sessionRow.status).toBe('settled')
    })

    it('parallel identical payShare -> no double tender (share_already_paid)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)

      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 2)
      const billRes = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      expect(billRes.status).toBe(201)
      const bill = billRes.body as BillBody
      const guest1Id = bill.shares[0].guestId
      const guest2Id = bill.shares[1].guestId

      // Double-tapped payShare on Guest 1's share before any share is finalized.
      const payShare1 = () =>
        authed(
          request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guest1Id}/pay`),
          tokens[0],
        ).send({ simulatedOutcome: 'success', payerPhone: '+91 90000 00001' })

      const [resA, resB] = await Promise.all([payShare1(), payShare1()])
      const statuses = [resA.status, resB.status].sort()
      expect(statuses).toEqual([200, 409])

      const failedRes = [resA, resB].find((r) => r.status === 409)!
      expect((failedRes.body as ErrorBody).error.code).toBe('share_already_paid')

      // Exactly 1 tender written - no duplicate tender!
      const tendersAfterG1 = await prisma.tender.findMany({ where: { billId: bill.id } })
      expect(tendersAfterG1).toHaveLength(1)

      // Bill is still open because Guest 2's share is outstanding.
      const billAfterG1 = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })
      expect(billAfterG1.status).toBe('open')

      // Guest 2 can now pay and successfully finalize without tender_mismatch.
      const g2Pay = await authed(
        request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guest2Id}/pay`),
        tokens[1],
      ).send({ simulatedOutcome: 'success', payerPhone: '+91 90000 00002' })
      expect(g2Pay.status).toBe(200)
      expect((g2Pay.body as BillBody).status).toBe('finalized')

      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(2)
    })

    it('two parallel payShare for distinct shares -> both recorded and bill finalized once', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)

      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 2)
      const billRes = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = billRes.body as BillBody
      const guest1Id = bill.shares[0].guestId
      const guest2Id = bill.shares[1].guestId

      // Guest 1 and Guest 2 pay simultaneously at the exact same moment.
      const [res1, res2] = await Promise.all([
        authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guest1Id}/pay`), tokens[0]).send({
          simulatedOutcome: 'success',
          payerPhone: '+91 90000 00001',
        }),
        authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guest2Id}/pay`), tokens[1]).send({
          simulatedOutcome: 'success',
          payerPhone: '+91 90000 00002',
        }),
      ])

      expect(res1.status).toBe(200)
      expect(res2.status).toBe(200)

      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(2)
      const finalBill = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })
      expect(finalBill.status).toBe('finalized')
      expect(finalBill.billNumber).toBe(1)
    })
  })

  describe('card intent vs cash finalize concurrency', () => {
    async function setUpOpenBillWithIntent(): Promise<{
      tenantId: string
      outletId: string
      billId: string
      token: string
      intentId: string
      totalMinor: number
    }> {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const staff = await createStaff(prisma, tenantId, outletId, 'Asha')
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)

      const orderRes = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), staff.token).send()
      const orderId = (orderRes.body as OrderBody).id
      await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), staff.token).send({ itemId, quantity: 2 })
      await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), staff.token).send({ status: 'sent' })

      const billRes = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), staff.token).send()
      expect(billRes.status).toBe(201)
      const bill = billRes.body as BillBody
      const totalMinor = bill.totalMinor

      await prisma.device.create({
        data: {
          id: uuidv7(),
          tenantId,
          outletId,
          label: 'Counter terminal',
          type: 'terminal',
          hardwareKeyFingerprint: `fp-${uuidv7()}`,
          enrolledAt: new Date(),
        },
      })

      const intentRes = await authed(request(httpServer).post(`/pos/v1/bills/${bill.id}/intents`), staff.token).send({
        rail: 'card_terminal',
        amountMinor: totalMinor,
        clientKey: uuidv7(),
      })
      expect(intentRes.status).toBe(201)
      const intent = intentRes.body as IntentBody

      // Expire the intent so cash finalize is not blocked by payment_pending,
      // simulating a late card capture racing cash settlement.
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { expiresAt: new Date(Date.now() - 1000) } })

      return { tenantId, outletId, billId: bill.id, token: staff.token, intentId: intent.id, totalMinor }
    }

    it('confirmIntent racing a cash finalize -> no second tender', async () => {
      const { billId, token, intentId, totalMinor } = await setUpOpenBillWithIntent()

      const cashFinalize = () =>
        authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), token).send({
          tenders: [{ method: 'cash', amountMinor: totalMinor }],
        })

      const simulateConfirm = () =>
        authed(request(httpServer).post(`/pos/v1/payment-intents/${intentId}/simulate`), token).send({
          outcome: 'success',
        })

      const [resCash, resSimulate] = await Promise.all([cashFinalize(), simulateConfirm()])

      // Regardless of which acquired the row lock first:
      // Exactly ONE tender must be recorded on the bill!
      const tenders = await prisma.tender.findMany({ where: { billId } })
      expect(tenders).toHaveLength(1)

      const billRow = await prisma.bill.findUniqueOrThrow({ where: { id: billId } })

      // Case A (cash won lock): cash finalize is 200, intent simulate is 200 with late_capture_refund_due.
      // Case B (intent won lock): intent simulate is 200, cash finalize is 400 (tender_mismatch); the card tender
      // does not finalize the bill by itself, so it stays open for the cashier to finalize.
      if (tenders[0].method === 'cash') {
        expect(billRow.status).toBe('finalized')
        expect(resCash.status).toBe(200)
        expect(resSimulate.status).toBe(200)
        const intentRow = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })
        expect(intentRow.status).toBe('succeeded')
        expect(intentRow.failureReason).toBe('late_capture_refund_due')
      } else {
        expect(tenders[0].method).toBe('card_terminal')
        expect(billRow.status).toBe('open')
        expect(resSimulate.status).toBe(200)
        expect(resCash.status).toBe(400)
        expect((resCash.body as ErrorBody).error.code).toBe('tender_mismatch')
      }
    })
  })
})
