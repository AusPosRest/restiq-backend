// #284: card payments on the guest's phone (Stripe direct charges on the restaurant's
// connected account), end to end against the real database. Stripe itself is a fake
// (StripeService overridden) - nothing here reaches Stripe.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import Stripe from 'stripe'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { StripeService, uuidv7 } from '../src/platform'

interface BillBody {
  id: string
  status: 'open' | 'finalized'
  totalMinor: number
  tenders: { method: string; amountMinor: number }[]
  shares: { guestId: string; amountMinor: number; status: 'outstanding' | 'paid'; payerPhone: string | null }[]
  paymentsAvailable: boolean
  cardPayments: { provider: string; publishableKey: string; stripeAccountId: string; allowedMethods: string[] } | null
}
interface StartBody {
  intentId: string
  clientSecret: string
  amountMinor: number
  currency: string
}
interface ErrorBody {
  error: { code: string }
}

type FakePi = { id: string; object: 'payment_intent'; amount: number; currency: string; status: Stripe.PaymentIntent.Status; client_secret: string; metadata: Record<string, string>; last_payment_error: null }

/** Just enough of the Stripe client for #284, recording every call. */
class FakeStripe {
  readonly intents = new Map<string, FakePi>()
  readonly calls: { method: string; params: unknown; options: unknown }[] = []
  readonly paymentIntents = {
    create: (params: { amount: number; currency: string; metadata: Record<string, string> }, options: unknown) => {
      this.calls.push({ method: 'create', params, options })
      const id = `pi_e2e_${this.intents.size + 1}`
      const pi: FakePi = { id, object: 'payment_intent', amount: params.amount, currency: params.currency, status: 'requires_payment_method', client_secret: `${id}_secret`, metadata: params.metadata, last_payment_error: null }
      this.intents.set(id, pi)
      return Promise.resolve(pi)
    },
    retrieve: (id: string, _params: unknown, options: unknown) => {
      this.calls.push({ method: 'retrieve', params: id, options })
      return Promise.resolve(this.intents.get(id))
    },
    cancel: (id: string, _params: unknown, options: unknown) => {
      this.calls.push({ method: 'cancel', params: id, options })
      const pi = this.intents.get(id)
      if (pi) pi.status = 'canceled'
      return Promise.resolve(pi)
    },
  }
}

const ACCOUNT = 'acct_e2e_restaurant'
const CONNECT_SECRET = 'whsec_connect_e2e'

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
  await prisma.tenantPaymentAccount.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

describe('/guest/v1 card payments via Stripe (#284, e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let stripe: FakeStripe
  const saved = { pk: process.env.STRIPE_PUBLISHABLE_KEY, sk: process.env.STRIPE_SECRET_KEY, wh: process.env.STRIPE_CONNECT_WEBHOOK_SECRET }

  beforeAll(async () => {
    prisma = createPrismaClient()
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_e2e'
    process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET
    const real = new StripeService()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue({ client: () => stripe, constructEvent: real.constructEvent.bind(real) })
      .compile()
    // rawBody: as main.ts - the Connect webhook verifies its signature over the raw bytes.
    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await wipe(prisma)
    await app.close()
    await prisma.$disconnect()
    for (const [name, value] of [['STRIPE_PUBLISHABLE_KEY', saved.pk], ['STRIPE_SECRET_KEY', saved.sk], ['STRIPE_CONNECT_WEBHOOK_SECRET', saved.wh]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  beforeEach(async () => {
    stripe = new FakeStripe()
    await wipe(prisma)
  })

  afterEach(() => {
    process.env.PAYMENTS_SIMULATOR = 'on'
  })

  const authed = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`)

  /** A Live AU tenant whose Stripe account is active, a table, and an order placed by `guests` guests at 1000 each. */
  async function liveTable(opts: { guests: number; live?: boolean; active?: boolean; kiosk?: boolean }) {
    const tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Card Co',
        registeredAddress: '1 Test Street',
        contactName: 'Test',
        contactEmail: 'contact@test.example',
        contactPhone: '+61 400 000 000',
        country: 'AU',
        status: 'active',
        plan: 'standard',
        billingPeriod: 'monthly',
        liveSince: opts.live === false ? null : new Date(Date.now() - 60_000),
      },
    })
    await prisma.tenantPaymentAccount.create({ data: { tenantId, stripeAccountId: ACCOUNT, cardPaymentsActive: opts.active ?? true, feePercentBps: 250, feeFixedMinor: 30n } })
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Card Brand' } })
    const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Main', address: 'A1', type: 'dine_in', timezone: 'Australia/Sydney' } })
    await prisma.outletCapability.create({ data: { tenantId, outletId: outlet.id, key: opts.kiosk ? 'kiosk' : 'qr_ordering', enabled: true } })
    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Dish', shortName: 'D', available: true } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 1000n, currency: 'AUD' } })

    let tokens: string[]
    if (opts.kiosk) {
      const device = await prisma.device.create({
        data: { tenantId, outletId: outlet.id, label: 'KIOSK-1', type: 'kiosk', status: 'active', hardwareKeyFingerprint: `fp-${uuidv7()}`, enrolledAt: new Date() },
      })
      const res = await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId: outlet.id, deviceId: device.id })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      tokens = [(res.body as { token: string }).token]
    } else {
      const floor = await prisma.floor.create({ data: { tenantId, outletId: outlet.id, name: 'Ground' } })
      const table = await prisma.diningTable.create({ data: { tenantId, floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 8 } })
      const start = await request(httpServer).post('/guest/v1/sessions').send({ outletId: outlet.id, tableId: table.id, name: 'Guest 1', phone: '+61 400 000 001' })
      expect(start.status, JSON.stringify(start.body)).toBe(201)
      const { token, pin } = start.body as { token: string; pin: string }
      tokens = [token]
      for (let i = 2; i <= opts.guests; i++) {
        const join = await request(httpServer).post('/guest/v1/sessions/join').send({ outletId: outlet.id, tableId: table.id, pin, name: `Guest ${i}` })
        tokens.push((join.body as { token: string }).token)
      }
    }
    for (const token of tokens) {
      expect((await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: item.id, quantity: 1 })).status).toBe(201)
    }
    const placed = await authed(request(httpServer).post('/guest/v1/orders'), tokens[0]).send({})
    expect(placed.status, JSON.stringify(placed.body)).toBe(201)
    const orderId = (placed.body as { orderId: string }).orderId
    const bill = await authed(request(httpServer).post(`/guest/v1/orders/${orderId}/bill`), tokens[0]).send()
    expect(bill.status, JSON.stringify(bill.body)).toBe(201)
    return { tenantId, tokens, bill: bill.body as BillBody }
  }

  function succeed(intentId: string) {
    const pi = [...stripe.intents.values()].find((p) => p.metadata.intentId === intentId)
    if (!pi) throw new Error('no such fake PaymentIntent')
    pi.status = 'succeeded'
    return pi
  }

  it('a Live tenant with an active account offers card payments in the bill view', async () => {
    process.env.PAYMENTS_SIMULATOR = 'off'
    const { bill } = await liveTable({ guests: 1 })
    expect(bill.cardPayments).toEqual({ provider: 'stripe', publishableKey: 'pk_test_e2e', stripeAccountId: ACCOUNT, allowedMethods: ['card', 'apple_pay', 'google_pay'] })
    expect(bill.paymentsAvailable).toBe(true)
  })

  it('Test mode, an inactive account, or a kiosk session: no cardPayments and card-payment is 409 provider_unavailable', async () => {
    process.env.PAYMENTS_SIMULATOR = 'off'
    for (const opts of [{ guests: 1, live: false }, { guests: 1, active: false }, { guests: 1, kiosk: true }]) {
      await wipe(prisma)
      const { tokens, bill } = await liveTable(opts)
      expect(bill.cardPayments, JSON.stringify(opts)).toBeNull()
      // Test mode keeps the simulator; a Live tenant without card payments has nothing.
      expect(bill.paymentsAvailable, JSON.stringify(opts)).toBe(opts.live === false)
      const res = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/card-payment`), tokens[0]).send({})
      expect(res.status, JSON.stringify(opts)).toBe(409)
      expect((res.body as ErrorBody).error.code).toBe('provider_unavailable')
    }
    expect(stripe.calls).toHaveLength(0)
  })

  it('a share: direct charge with the platform fee, reused on a retry, settled by sync', async () => {
    const { tokens, bill } = await liveTable({ guests: 2 })
    const share = bill.shares[0]
    const url = `/guest/v1/bills/${bill.id}/card-payment`
    const first = await authed(request(httpServer).post(url), tokens[0]).send({ guestId: share.guestId, payerPhone: '+61 411 111 111' })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const started = first.body as StartBody
    expect(started).toMatchObject({ amountMinor: share.amountMinor, currency: 'AUD', clientSecret: 'pi_e2e_1_secret' })
    expect(stripe.calls[0]).toMatchObject({
      method: 'create',
      params: { amount: share.amountMinor, currency: 'aud', automatic_payment_methods: { enabled: true }, application_fee_amount: Math.round((share.amountMinor * 250) / 10_000) + 30, metadata: { billId: bill.id, intentId: started.intentId, guestId: share.guestId } },
      options: { stripeAccount: ACCOUNT, idempotencyKey: `restiq-card-payment-${started.intentId}` },
    })
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.intentId } })).toMatchObject({ provider: 'stripe', rail: 'card_online', status: 'pending', providerRef: 'pi_e2e_1' })

    const again = await authed(request(httpServer).post(url), tokens[1]).send({ guestId: share.guestId })
    expect((again.body as StartBody).intentId).toBe(started.intentId)
    expect(stripe.intents.size).toBe(1)

    // Not paid yet: sync changes nothing.
    const early = await authed(request(httpServer).post(`/guest/v1/card-payments/${started.intentId}/sync`), tokens[0]).send({})
    expect(early.status).toBe(200)
    expect((early.body as BillBody).shares[0].status).toBe('outstanding')

    succeed(started.intentId)
    for (let i = 0; i < 2; i++) {
      const synced = await authed(request(httpServer).post(`/guest/v1/card-payments/${started.intentId}/sync`), tokens[0]).send({})
      expect(synced.status).toBe(200)
      const view = synced.body as BillBody
      expect(view.shares.find((s) => s.guestId === share.guestId)).toMatchObject({ status: 'paid', payerPhone: '+61 411 111 111' })
      expect(view.status).toBe('open')
      expect(view.tenders).toEqual([expect.objectContaining({ method: 'card_online', amountMinor: share.amountMinor })])
    }

    const paidAgain = await authed(request(httpServer).post(url), tokens[0]).send({ guestId: share.guestId })
    expect((paidAgain.body as ErrorBody).error.code).toBe('share_already_paid')
    const whole = await authed(request(httpServer).post(url), tokens[0]).send({})
    expect((whole.body as ErrorBody).error.code).toBe('partial_payment_exists')
  })

  it('the whole bill, settled by a signed Connect webhook, completes the bill', async () => {
    const { tokens, bill } = await liveTable({ guests: 2 })
    const res = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/card-payment`), tokens[0]).send({})
    const started = res.body as StartBody
    expect(started.amountMinor).toBe(bill.totalMinor)

    const pi = succeed(started.intentId)
    const payload = JSON.stringify({ id: 'evt_e2e', object: 'event', type: 'payment_intent.succeeded', account: ACCOUNT, data: { object: pi } })
    const signer = new Stripe('sk_test_never_called')
    const bad = await request(httpServer).post('/webhooks/stripe/connect').set('Content-Type', 'application/json').set('Stripe-Signature', signer.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' })).send(payload)
    expect(bad.status).toBe(400)

    const wrongAccount = JSON.stringify({ id: 'evt_e2e_x', object: 'event', type: 'payment_intent.succeeded', account: 'acct_someone_else', data: { object: pi } })
    const ignored = await request(httpServer).post('/webhooks/stripe/connect').set('Content-Type', 'application/json').set('Stripe-Signature', signer.webhooks.generateTestHeaderString({ payload: wrongAccount, secret: CONNECT_SECRET })).send(wrongAccount)
    expect(ignored.body).toEqual({ received: true, result: 'ignored' })

    const ok = await request(httpServer).post('/webhooks/stripe/connect').set('Content-Type', 'application/json').set('Stripe-Signature', signer.webhooks.generateTestHeaderString({ payload, secret: CONNECT_SECRET })).send(payload)
    expect(ok.body).toEqual({ received: true, result: 'applied' })

    const final = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id }, include: { tenders: true, shares: true } })
    expect(final.status).toBe('finalized')
    expect(final.tenders).toHaveLength(1)
    expect(final.tenders[0]).toMatchObject({ method: 'card_online', amountMinor: BigInt(bill.totalMinor) })
    expect(final.shares.every((s) => s.status === 'paid')).toBe(true)

    // Late: a second whole-bill attempt that somehow captured is flagged for a refund, never a second tender.
    const late = await prisma.paymentIntent.create({
      data: { tenantId: final.tenantId, outletId: final.outletId, billId: bill.id, rail: 'card_online', provider: 'stripe', amountMinor: BigInt(bill.totalMinor), currency: 'AUD', status: 'pending', clientKey: 'stripe:pi_late', providerRef: 'pi_late', clientPayload: {}, expiresAt: new Date() },
    })
    stripe.intents.set('pi_late', { ...pi, id: 'pi_late', metadata: { ...pi.metadata, intentId: late.id } })
    const lateEvent = JSON.stringify({ id: 'evt_late', object: 'event', type: 'payment_intent.succeeded', account: ACCOUNT, data: { object: stripe.intents.get('pi_late') } })
    await request(httpServer).post('/webhooks/stripe/connect').set('Content-Type', 'application/json').set('Stripe-Signature', signer.webhooks.generateTestHeaderString({ payload: lateEvent, secret: CONNECT_SECRET })).send(lateEvent)
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ status: 'succeeded', failureReason: 'late_capture_refund_due' })
    expect(await prisma.tender.count({ where: { billId: bill.id } })).toBe(1)
  })

  it('a bill changed after the attempt started: the old PaymentIntent is cancelled at Stripe and a new one made', async () => {
    const { tenantId, tokens, bill } = await liveTable({ guests: 1 })
    const url = `/guest/v1/bills/${bill.id}/card-payment`
    const first = (await authed(request(httpServer).post(url), tokens[0]).send({})).body as StartBody
    // Staff add a line to the order - the total rises.
    const order = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id }, select: { orderId: true } })
    const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: order.orderId } })
    await prisma.orderLine.create({ data: { ...line, id: uuidv7(), tenantId, guestId: null, guestName: null, createdAt: new Date() } })
    const second = (await authed(request(httpServer).post(url), tokens[0]).send({})).body as StartBody
    expect(second.intentId).not.toBe(first.intentId)
    expect(second.amountMinor).toBeGreaterThan(first.amountMinor)
    expect(stripe.calls.some((c) => c.method === 'cancel' && c.params === 'pi_e2e_1')).toBe(true)
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: first.intentId } })).toMatchObject({ status: 'cancelled', failureReason: 'superseded' })
  })
})
