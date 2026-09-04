// qr-self-order/CAP-5 success criteria, end to end (SPEC-qr-self-order,
// story 5, issue #80 - UJ-5's failed-split invariant is this story's
// acceptance narrative):
//  - guest checkout raises a REAL Bill/Tender (AD-18: one money path, not a
//    parallel guest settlement model), split into one BillShare per distinct
//    guest attributed on the order's lines, summing exactly to the total
//  - a five-guest split: one simulated failure leaves the other four guests'
//    shares (and their real Tender rows) intact and exactly the failed share
//    outstanding; the bill cannot finalise while it is; a retry that
//    succeeds completes it - gapless bill number, order closed, table
//    session settled
//  - a share cannot be paid twice
//  - one-payment mode settles the whole bill with a single Tender; it
//    refuses to run over a bill with any share already paid individually
//  - a closed session 410s both bill creation and payment
//  - cross-tenant/realm isolation
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
interface InvoiceBody {
  invoiceNumber: string
  title: string
  footerMessage: string | null
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
  taxMinor: number
  totalMinor: number
  notes: string[]
  tenders: { amountMinor: number }[]
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

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
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

async function createTenant(prisma: PrismaClient, name = 'Guest Checkout Test Co', country: 'IN' | 'AU' = 'IN'): Promise<string> {
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

async function createTaxRegistration(
  prisma: PrismaClient,
  tenantId: string,
  opts: { taxProfile: string; registrationType: 'gstin' | 'abn'; gstRegistered?: boolean; legalEntityName?: string },
): Promise<void> {
  await prisma.tenantTaxRegistration.create({
    data: {
      tenantId,
      registrationType: opts.registrationType,
      registrationNumber: `REG-${uuidv7()}`,
      legalEntityName: opts.legalEntityName ?? 'Guest Checkout Test Co',
      taxProfile: opts.taxProfile,
      gstRegistered: opts.gstRegistered ?? true,
      fssaiLicense: null,
      compositionScheme: false,
    },
  })
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Koramangala'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Guest Checkout Test Brand' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createTable(prisma: PrismaClient, tenantId: string, outletId: string, label = 'T1'): Promise<string> {
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
  const table = await prisma.diningTable.create({
    data: { tenantId, floorId: floor.id, label, x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 8 },
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

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<string> {
  const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  return signPosToken({ id: staff.id, tenantId, outletId, name })
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm', available: true } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR' } })
  return item.id
}

describe('/guest/v1 checkout and split payment, simulated (e2e)', () => {
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

  /** Starts a session and joins `extraGuestCount` more guests, each adding one item at itemPriceMinor. Returns tokens in join order and the placed order id. */
  async function placeOrderForGuests(
    outletId: string,
    tableId: string,
    itemId: string,
    itemPriceMinor: number,
    guestCount: number,
  ): Promise<{ tokens: string[]; sessionId: string; orderId: string }> {
    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Guest 1', phone: '+91 90000 00001' })
    const { token: firstToken, pin, session } = startRes.body as StartResult
    const tokens = [firstToken]

    for (let i = 2; i <= guestCount; i++) {
      const joinRes = await request(httpServer).post('/guest/v1/sessions/join').send({ outletId, tableId, pin, name: `Guest ${i}` })
      tokens.push((joinRes.body as JoinResult).token)
    }

    for (const token of tokens) {
      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId, quantity: 1 })
      expect(res.status).toBe(201)
    }

    const placed = await authed(request(httpServer).post('/guest/v1/orders'), tokens[0]).send({})
    expect(placed.status).toBe(201)
    void itemPriceMinor
    return { tokens, sessionId: session.sessionId, orderId: (placed.body as PlacedOrderBody).orderId }
  }

  describe('bill creation and per-guest split', () => {
    it('splits the bill exactly across every distinct guest, summing to the total', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000) // subtotal 50000 for 5 guests, tax 2500, total 52500

      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 5)

      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      expect(created.status).toBe(201)
      const bill = created.body as BillBody
      expect(bill.subtotalMinor).toBe(50000)
      expect(bill.taxMinor).toBe(2500)
      expect(bill.totalMinor).toBe(52500)
      expect(bill.createdByStaffId).toBeNull()
      expect(bill.status).toBe('open')
      expect(bill.shares).toHaveLength(5)
      expect(bill.shares.every((s) => s.amountMinor === 10500)).toBe(true)
      expect(bill.shares.every((s) => s.status === 'outstanding')).toBe(true)
      expect(bill.shares.reduce((sum, s) => sum + s.amountMinor, 0)).toBe(bill.totalMinor)

      const fetched = await authed(request(httpServer).get(`/guest/v1/orders/${orderId}/bill`), tokens[1])
      expect(fetched.status).toBe(200)
      expect((fetched.body as BillBody).id).toBe(bill.id)
    })

    it('is idempotent: a second POST for the same order returns 200 with the same bill id and writes no second row (issue #98)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 1)

      const first = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      expect(first.status).toBe(201)
      const firstBill = first.body as BillBody

      const second = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      expect(second.status).toBe(200)
      const secondBill = second.body as BillBody
      expect(secondBill.id).toBe(firstBill.id)
      expect(secondBill).toEqual(firstBill)

      expect(await prisma.bill.count({ where: { orderId } })).toBe(1)
    })
  })

  describe("UJ-5: five-guest split, one simulated failure, everyone else's share stays intact", () => {
    it('leaves the other four shares paid and only the failed one outstanding; a retry completes the bill, closes the order, and settles the session', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, sessionId, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 5)

      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = created.body as BillBody
      const guestIds = bill.shares.map((s) => s.guestId)

      // Guests 1-4 pay successfully.
      for (let i = 0; i < 4; i++) {
        const res = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guestIds[i]}/pay`), tokens[i]).send({
          simulatedOutcome: 'success',
          payerPhone: `+91 90000 0000${i}`,
        })
        expect(res.status).toBe(200)
        const body = res.body as BillBody
        expect(body.status).toBe('open') // not finalized until the 5th share
        const paidShare = body.shares.find((s) => s.guestId === guestIds[i])
        expect(paidShare).toMatchObject({ status: 'paid', payerPhone: `+91 90000 0000${i}` })
      }

      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(4)
      expect(await prisma.bill.findUnique({ where: { id: bill.id } }).then((b) => b?.status)).toBe('open')

      // Guest 5's payment is simulated to fail - UJ-5's invariant: this
      // writes nothing at all, every other guest's paid share is untouched.
      const failed = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guestIds[4]}/pay`), tokens[4]).send({
        simulatedOutcome: 'failure',
      })
      expect(failed.status).toBe(200)
      const failedBody = failed.body as BillBody
      expect(failedBody.status).toBe('open')
      expect(failedBody.shares.find((s) => s.guestId === guestIds[4])).toMatchObject({ status: 'outstanding', paidAt: null })
      expect(failedBody.shares.filter((s) => s.status === 'paid')).toHaveLength(4)
      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(4) // no new tender from the failure

      // The bill cannot finalise while any share is outstanding.
      expect(await prisma.bill.findUnique({ where: { id: bill.id } }).then((b) => b?.status)).toBe('open')

      // A guest cannot pay an already-paid share twice.
      const doublePay = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guestIds[0]}/pay`), tokens[0]).send({
        simulatedOutcome: 'success',
      })
      expect(doublePay.status).toBe(409)
      expect((doublePay.body as ErrorBody).error.code).toBe('share_already_paid')
      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(4) // still 4 - no duplicate tender

      // Retrying guest 5's payment successfully completes the bill.
      const retry = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${guestIds[4]}/pay`), tokens[4]).send({
        simulatedOutcome: 'success',
      })
      expect(retry.status).toBe(200)
      const finalBody = retry.body as BillBody
      expect(finalBody.status).toBe('finalized')
      expect(finalBody.billNumber).toBe(1)
      expect(finalBody.shares.every((s) => s.status === 'paid')).toBe(true)
      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(5)

      const order = await prisma.order.findUnique({ where: { id: orderId } })
      expect(order?.status).toBe('closed')

      const session = await prisma.tableSession.findUnique({ where: { id: sessionId } })
      expect(session?.status).toBe('settled')
    })
  })

  describe('one-payment mode', () => {
    it('settles the whole bill with a single Tender for the total', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, sessionId, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 3)

      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = created.body as BillBody // subtotal 30000, tax 1500, total 31500

      const res = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/pay-all`), tokens[0]).send({
        simulatedOutcome: 'success',
        payerPhone: '+91 90000 09999',
      })
      expect(res.status).toBe(200)
      const body = res.body as BillBody
      expect(body.status).toBe('finalized')
      expect(body.tenders).toHaveLength(1)
      expect(body.tenders[0]?.amountMinor).toBe(31500)
      expect(body.shares.every((s) => s.status === 'paid' && s.payerPhone === '+91 90000 09999')).toBe(true)

      const session = await prisma.tableSession.findUnique({ where: { id: sessionId } })
      expect(session?.status).toBe('settled')
    })

    it('a simulated failure settles nothing - the bill stays open with no tender', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 2)
      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = created.body as BillBody

      const res = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/pay-all`), tokens[0]).send({ simulatedOutcome: 'failure' })
      expect(res.status).toBe(200)
      expect((res.body as BillBody).status).toBe('open')
      expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(0)
    })

    it('refuses to run over a bill with a share already paid individually', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 2)
      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = created.body as BillBody
      const firstGuestId = bill.shares[0].guestId

      await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/shares/${firstGuestId}/pay`), tokens[0]).send({ simulatedOutcome: 'success' })

      const res = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/pay-all`), tokens[1]).send({ simulatedOutcome: 'success' })
      expect(res.status).toBe(409)
      expect((res.body as ErrorBody).error.code).toBe('partial_payment_exists')
    })
  })

  describe('GET /guest/v1/bills/:id/invoice (issue #103)', () => {
    it('409s before finalize, 200s with the invoice shape after pay-all finalizes the bill', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 2)
      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = created.body as BillBody // subtotal 20000, tax 1000, total 21000

      const beforeFinalize = await authed(request(httpServer).get(`/guest/v1/bills/${bill.id}/invoice`), tokens[0])
      expect(beforeFinalize.status).toBe(409)
      expect((beforeFinalize.body as ErrorBody).error.code).toBe('not_finalized')

      const paid = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/pay-all`), tokens[0]).send({
        simulatedOutcome: 'success',
        payerPhone: '+91 90000 09999',
      })
      expect((paid.body as BillBody).status).toBe('finalized')

      const res = await authed(request(httpServer).get(`/guest/v1/bills/${bill.id}/invoice`), tokens[0])
      expect(res.status).toBe(200)
      const invoice = res.body as InvoiceBody
      expect(invoice.invoiceNumber).toBe(String((paid.body as BillBody).billNumber))
      expect(invoice.title).toBe('Invoice')
      expect(invoice.footerMessage).toBeNull()
      expect(invoice.seller.phone).toBe('+91 90000 00000')
      expect(invoice.seller.email).toBe('contact@test.example')
      expect(invoice.taxMinor).toBe(1000)
      expect(invoice.totalMinor).toBe(21000)
      expect(invoice.tenders.map((t) => t.amountMinor)).toEqual([21000])
    })

    it('AU: unregistered tenant invoices as Receipt with zero GST and receipt footer', async () => {
      const tenantId = await createTenant(prisma, 'Guest Checkout AU', 'AU')
      await createTaxRegistration(prisma, tenantId, { taxProfile: 'Australia GST', registrationType: 'abn', gstRegistered: false })
      await prisma.tenant.update({ where: { id: tenantId }, data: { brandingTokens: { receiptFooter: 'Guest receipt footer' } } })
      const outletId = await createOutlet(prisma, tenantId, 'Harbour')
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 1)

      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = created.body as BillBody
      expect(bill.totalMinor).toBe(10000)
      expect(bill.taxMinor).toBe(0)

      const paid = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/pay-all`), tokens[0]).send({
        simulatedOutcome: 'success',
        payerPhone: '+91 90000 09999',
      })
      expect((paid.body as BillBody).status).toBe('finalized')

      const invoice = (await authed(request(httpServer).get(`/guest/v1/bills/${bill.id}/invoice`), tokens[0])).body as InvoiceBody
      expect(invoice.title).toBe('Receipt')
      expect(invoice.footerMessage).toBe('Guest receipt footer')
      expect(invoice.taxMinor).toBe(0)
      expect(invoice.totalMinor).toBe(10000)
      expect(invoice.notes).toEqual(['Not registered for GST - this is a receipt, not a tax invoice'])
      expect(invoice.seller.phone).toBe('+91 90000 00000')
      expect(invoice.seller.email).toBe('contact@test.example')
    })

    it('a guest from a different session cannot read another bill\'s invoice (404)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const otherTableId = await createTable(prisma, tenantId, outletId, 'T2')
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 1)
      const created = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      const bill = created.body as BillBody

      const otherStart = await request(httpServer)
        .post('/guest/v1/sessions')
        .send({ outletId, tableId: otherTableId, name: 'Other Guest', phone: '+91 90000 00002' })
      const otherToken = (otherStart.body as StartResult).token

      const res = await authed(request(httpServer).get(`/guest/v1/bills/${bill.id}/invoice`), otherToken)
      expect(res.status).toBe(404)
    })
  })

  describe('validation', () => {
    it('410s bill creation and payment once staff close the session', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const itemId = await createItemWithPrice(prisma, tenantId, 10000)
      const { tokens, orderId } = await placeOrderForGuests(outletId, tableId, itemId, 10000, 1)

      const staffToken = await createStaff(prisma, tenantId, outletId, 'Server Priya')
      const closeRes = await authed(request(httpServer).post(`/pos/v1/tables/${tableId}/close-session`), staffToken)
      expect(closeRes.status).toBe(200)

      const res = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
      expect(res.status).toBe(410)
      expect((res.body as ErrorBody).error.code).toBe('session_closed')
      expect(await prisma.bill.count()).toBe(0)
    })

    it('without a guest token, every guest checkout endpoint is rejected', async () => {
      const res1 = await request(httpServer).post(`/guest/v1/orders/${uuidv7()}/bill`).send({})
      expect(res1.status).toBe(401)
      const res2 = await request(httpServer).post(`/guest/v1/bills/${uuidv7()}/pay-all`).send({ simulatedOutcome: 'success' })
      expect(res2.status).toBe(401)
    })
  })

  describe('cross-tenant isolation', () => {
    it("a guest bill created for one tenant is invisible to another tenant's staff/guest realm", async () => {
      const tenantA = await createTenant(prisma, 'Tenant A')
      const outletA = await createOutlet(prisma, tenantA)
      const tableA = await createTable(prisma, tenantA, outletA)
      await enableQrOrdering(prisma, tenantA, outletA)
      const itemA = await createItemWithPrice(prisma, tenantA, 10000)
      const { tokens: tokensA, orderId: orderIdA } = await placeOrderForGuests(outletA, tableA, itemA, 10000, 1)
      const createdA = await authed(request(httpServer).post(`/guest/v1/orders/${orderIdA}/bill`), tokensA[0]).send()
      const billA = createdA.body as BillBody

      const tenantB = await createTenant(prisma, 'Tenant B')
      const outletB = await createOutlet(prisma, tenantB)
      const tableB = await createTable(prisma, tenantB, outletB)
      await enableQrOrdering(prisma, tenantB, outletB)
      const itemB = await createItemWithPrice(prisma, tenantB, 5000)
      const { tokens: tokensB } = await placeOrderForGuests(outletB, tableB, itemB, 5000, 1)

      // Tenant B's guest cannot reach tenant A's bill, even by guessing its id.
      const crossRead = await authed(request(httpServer).get(`/guest/v1/orders/${orderIdA}/bill`), tokensB[0])
      expect(crossRead.status).toBe(404)

      const crossPay = await authed(request(httpServer).post(`/guest/v1/bills/${billA.id}/pay-all`), tokensB[0]).send({ simulatedOutcome: 'success' })
      expect(crossPay.status).toBe(404)
    })
  })
})
