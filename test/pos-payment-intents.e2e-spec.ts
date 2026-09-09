// Payments, first slice (issue #130 / epic #129): the simulated card
// terminal, end to end -
//  - a cashier sends an amount to the terminal (an intent, 201; idempotent
//    per clientKey; never more than what is still due; one active per bill)
//  - the terminal device polls its own outlet's pending intents (403 for
//    another outlet's staff)
//  - Approve writes the card_terminal Tender in the same transaction and the
//    bill then finalises with the remaining cash; a second Approve is a no-op
//  - a bill cannot finalise while an intent is pending (409 payment_pending)
//  - Decline, cancel and expiry leave no Tender behind and free the bill for
//    another attempt
//  - the DB CHECK forbids an electronic tender without an intent
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
interface TenderBody {
  id: string
  method: string
  amountMinor: number
  paymentIntentId: string | null
  riskAcknowledged: boolean
}
interface BillBody {
  id: string
  status: 'open' | 'finalized'
  totalMinor: number
  billNumber: number | null
  tenders: TenderBody[]
}
interface IntentBody {
  id: string
  billId: string
  shareGuestId: string | null
  rail: string
  provider: string
  amountMinor: number
  currency: string
  status: string
  failureReason: string | null
  providerRef: string | null
  client: { simulated?: boolean }
  createdAt: string
  expiresAt: string
  succeededAt: string | null
  tenderId: string | null
}
interface OrderBody {
  id: string
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.printJob.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.billShare.deleteMany()
  // tenders FK to payment_intents (RESTRICT), payment_intents FK to bills and
  // staff_users - so tenders, then intents, then everything they point at.
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

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Role-${uuidv7()}`, isSystem: false, isManager: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const token = signPosToken({ id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm' } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR', channel: 'dine_in' } })
  return item.id
}

describe('/pos/v1 payment intents - simulated card terminal (e2e)', () => {
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
    // Leave no payment_intents behind: later spec files' own wipe() helpers
    // predate this table and would trip its RESTRICT FKs on bills/staff.
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

  /** A sent 2 x 10000 dine-in order with its open bill (21000 total at the 5% placeholder tax) and the owner's token. */
  async function setUpOpenBill(): Promise<{ tenantId: string; outletId: string; billId: string; token: string }> {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
    const itemId = await createItemWithPrice(prisma, tenantId, 10000)
    const opened = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()
    const orderId = (opened.body as OrderBody).id
    await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), owner.token).send({ itemId, quantity: 2 })
    await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), owner.token).send({ status: 'sent' })
    const created = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), owner.token).send()
    expect(created.status).toBe(201)
    return { tenantId, outletId, billId: (created.body as BillBody).id, token: owner.token }
  }

  function sendToTerminal(billId: string, token: string, amountMinor: number, clientKey = uuidv7()): request.Test {
    return authed(request(httpServer).post(`/pos/v1/bills/${billId}/intents`), token).send({ rail: 'card_terminal', amountMinor, clientKey })
  }

  describe('sending an amount to the terminal', () => {
    it('creates a pending simulated intent for the amount, idempotent per clientKey, and refuses a second active one', async () => {
      const { billId, token } = await setUpOpenBill()
      const clientKey = uuidv7()

      const res = await sendToTerminal(billId, token, 15000, clientKey)
      expect(res.status).toBe(201)
      const intent = res.body as IntentBody
      expect(intent).toMatchObject({
        billId,
        shareGuestId: null,
        rail: 'card_terminal',
        provider: 'simulated',
        amountMinor: 15000,
        currency: 'INR',
        status: 'pending',
        failureReason: null,
        providerRef: null,
        client: { simulated: true },
        succeededAt: null,
        tenderId: null,
      })
      // 5-minute TTL, give or take the request's own duration.
      expect(Date.parse(intent.expiresAt) - Date.parse(intent.createdAt)).toBeGreaterThan(4 * 60_000)

      const repeat = await sendToTerminal(billId, token, 15000, clientKey)
      expect(repeat.status).toBe(200)
      expect((repeat.body as IntentBody).id).toBe(intent.id)

      const second = await sendToTerminal(billId, token, 6000)
      expect(second.status).toBe(409)
      expect((second.body as ErrorBody).error.code).toBe('intent_active')

      expect(await prisma.paymentIntent.count({ where: { billId } })).toBe(1)
    })

    it('never asks the terminal for more than what is still due', async () => {
      const { billId, token } = await setUpOpenBill()
      const res = await sendToTerminal(billId, token, 21001)
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('amount_exceeds_remaining')
      expect(await prisma.paymentIntent.count({ where: { billId } })).toBe(0)
    })

    it('rejects an unknown rail and a zero amount at the DTO', async () => {
      const { billId, token } = await setUpOpenBill()
      expect((await authed(request(httpServer).post(`/pos/v1/bills/${billId}/intents`), token).send({ rail: 'upi_qr', amountMinor: 100, clientKey: 'k' })).status).toBe(400)
      expect((await authed(request(httpServer).post(`/pos/v1/bills/${billId}/intents`), token).send({ rail: 'card_terminal', amountMinor: 0, clientKey: 'k' })).status).toBe(400)
    })
  })

  describe('the terminal device', () => {
    it('polls its own outlet\'s pending intents, oldest first, and another outlet\'s staff get 403', async () => {
      const { tenantId, outletId, billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 15000)).body as IntentBody

      const pending = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/payment-intents`), token)
      expect(pending.status).toBe(200)
      expect((pending.body as IntentBody[]).map((i) => i.id)).toEqual([intent.id])

      const otherOutletId = await createOutlet(prisma, tenantId, 'Koramangala')
      const outsider = await createStaff(prisma, tenantId, otherOutletId, 'Ravi')
      expect((await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/payment-intents`), outsider.token)).status).toBe(403)
    })

    it('Approve writes the card_terminal tender in the same step, the bill then finalises with the remaining cash, and a second Approve is a no-op', async () => {
      const { outletId, billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 15000)).body as IntentBody

      const approved = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/simulate`), token).send({ outcome: 'success' })
      expect(approved.status).toBe(200)
      const done = approved.body as IntentBody
      expect(done.status).toBe('succeeded')
      expect(done.succeededAt).not.toBeNull()
      expect(done.tenderId).not.toBeNull()

      const bill = (await authed(request(httpServer).get(`/pos/v1/bills/${billId}`), token)).body as BillBody
      expect(bill.status).toBe('open')
      expect(bill.tenders).toHaveLength(1)
      expect(bill.tenders[0]).toMatchObject({ id: done.tenderId, method: 'card_terminal', amountMinor: 15000, paymentIntentId: intent.id })

      // The terminal's queue is empty again; the settle screen's poll sees the same terminal state.
      expect((await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/payment-intents`), token)).body).toEqual([])
      expect(((await authed(request(httpServer).get(`/pos/v1/payment-intents/${intent.id}`), token)).body as IntentBody).status).toBe('succeeded')

      const again = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/simulate`), token).send({ outcome: 'success' })
      expect(again.status).toBe(200)
      expect((again.body as IntentBody).tenderId).toBe(done.tenderId)
      expect(await prisma.tender.count({ where: { billId } })).toBe(1)

      const declineAfter = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/simulate`), token).send({ outcome: 'failure' })
      expect(declineAfter.status).toBe(409)
      expect((declineAfter.body as ErrorBody).error.code).toBe('already_terminal')

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), token).send({
        tenders: [{ method: 'cash', amountMinor: 6000 }],
      })
      expect(finalized.status).toBe(200)
      const final = finalized.body as BillBody
      expect(final.status).toBe('finalized')
      expect(final.billNumber).toBe(1)
      expect(final.tenders.map((t) => [t.method, t.amountMinor])).toEqual([
        ['card_terminal', 15000],
        ['cash', 6000],
      ])

      // A cash tender still carries the (unenforced yet) FR-52 flag as given.
      expect(final.tenders[1].riskAcknowledged).toBe(false)
    })

    it('refuses to finalise while the terminal is still waiting (409 payment_pending); Decline frees the bill with no tender', async () => {
      const { billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 21000)).body as IntentBody

      const blocked = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), token).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect(blocked.status).toBe(409)
      expect((blocked.body as ErrorBody).error.code).toBe('payment_pending')
      // The rejected finalise wrote nothing - no tender, no number.
      expect(await prisma.tender.count({ where: { billId } })).toBe(0)

      const declined = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/simulate`), token).send({ outcome: 'failure' })
      expect(declined.status).toBe(200)
      expect((declined.body as IntentBody).status).toBe('failed')
      expect((declined.body as IntentBody).failureReason).toBe('declined')
      expect((declined.body as IntentBody).tenderId).toBeNull()
      expect(await prisma.tender.count({ where: { billId } })).toBe(0)

      // A fresh attempt is allowed now, and cash alone finalises fine.
      expect((await sendToTerminal(billId, token, 21000)).status).toBe(201)
      const cancelled = await authed(request(httpServer).post(`/pos/v1/payment-intents/${((await prisma.paymentIntent.findFirstOrThrow({ where: { billId, status: 'pending' } })).id)}/cancel`), token).send()
      expect(cancelled.status).toBe(200)
      expect((cancelled.body as IntentBody).status).toBe('cancelled')

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), token).send({
        tenders: [{ method: 'cash', amountMinor: 21000 }],
      })
      expect(finalized.status).toBe(200)
    })

    it('cancel is idempotent on an over intent and refuses to cancel money that moved', async () => {
      const { billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 5000)).body as IntentBody

      const first = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/cancel`), token).send()
      expect((first.body as IntentBody).status).toBe('cancelled')
      const second = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/cancel`), token).send()
      expect(second.status).toBe(200)
      expect((second.body as IntentBody).status).toBe('cancelled')

      const paid = (await sendToTerminal(billId, token, 5000)).body as IntentBody
      await authed(request(httpServer).post(`/pos/v1/payment-intents/${paid.id}/simulate`), token).send({ outcome: 'success' })
      const refused = await authed(request(httpServer).post(`/pos/v1/payment-intents/${paid.id}/cancel`), token).send()
      expect(refused.status).toBe(409)
      expect((refused.body as ErrorBody).error.code).toBe('already_succeeded')
    })

    it('expires an intent past its TTL on the next read, drops it from the terminal queue, and lets a new one be sent', async () => {
      const { outletId, billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 15000)).body as IntentBody
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { expiresAt: new Date(Date.now() - 1000) } })

      expect((await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/payment-intents`), token)).body).toEqual([])
      const read = (await authed(request(httpServer).get(`/pos/v1/payment-intents/${intent.id}`), token)).body as IntentBody
      expect(read.status).toBe('expired')
      expect(read.failureReason).toBe('timed_out')

      expect((await sendToTerminal(billId, token, 15000)).status).toBe(201)
      expect(await prisma.tender.count({ where: { billId } })).toBe(0)
    })

    it('a capture that lands after expiry still records the tender (ADR-011)', async () => {
      const { billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 15000)).body as IntentBody
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'expired', failureReason: 'timed_out' } })

      const late = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/simulate`), token).send({ outcome: 'success' })
      expect(late.status).toBe(200)
      expect((late.body as IntentBody).status).toBe('succeeded')
      expect(await prisma.tender.count({ where: { billId, method: 'card_terminal' } })).toBe(1)
    })
  })

  describe('finalising on the terminal alone', () => {
    it('finalises with an empty cashier tender list when the terminal covered the whole bill', async () => {
      const { billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 21000)).body as IntentBody
      await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/simulate`), token).send({ outcome: 'success' })

      const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), token).send({ tenders: [] })
      expect(finalized.status).toBe(200)
      const bill = finalized.body as BillBody
      expect(bill.status).toBe('finalized')
      expect(bill.tenders.map((t) => [t.method, t.amountMinor, t.paymentIntentId])).toEqual([['card_terminal', 21000, intent.id]])
    })
  })

  describe('money-path invariants', () => {
    it('the database refuses an electronic tender with no intent behind it, and a cash tender that claims one', async () => {
      const { tenantId, billId, token } = await setUpOpenBill()
      await expect(prisma.tender.create({ data: { id: uuidv7(), tenantId, billId, method: 'card_terminal', amountMinor: 100n } })).rejects.toThrow()

      const intent = (await sendToTerminal(billId, token, 100)).body as IntentBody
      await expect(prisma.tender.create({ data: { id: uuidv7(), tenantId, billId, method: 'cash', amountMinor: 100n, paymentIntentId: intent.id } })).rejects.toThrow()
      expect(await prisma.tender.count({ where: { billId } })).toBe(0)
    })

    it('an intent on a finalised bill is refused, and another tenant cannot see this tenant\'s intent', async () => {
      const { billId, token } = await setUpOpenBill()
      const intent = (await sendToTerminal(billId, token, 5000)).body as IntentBody
      await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/simulate`), token).send({ outcome: 'success' })
      await authed(request(httpServer).post(`/pos/v1/bills/${billId}/finalize`), token).send({ tenders: [{ method: 'cash', amountMinor: 16000 }] })

      const late = await sendToTerminal(billId, token, 100)
      expect(late.status).toBe(409)
      expect((late.body as ErrorBody).error.code).toBe('already_finalized')

      const otherTenantId = await createTenant(prisma, 'Other Group')
      const otherOutletId = await createOutlet(prisma, otherTenantId)
      const stranger = await createStaff(prisma, otherTenantId, otherOutletId, 'Zara')
      expect((await authed(request(httpServer).get(`/pos/v1/payment-intents/${intent.id}`), stranger.token)).status).toBe(404)
    })
  })
})
