// #286: Stripe card readers and reader orders, end to end against the real database. Stripe itself is
// a fake (StripeService overridden) - nothing here reaches Stripe.
//  - ops: reader prices; register (first reader makes the outlet's Terminal Location), list, remove
//  - POS: outlet readers; a card_terminal intent needs a reader and runs on Stripe; GET syncs from
//    Stripe; decline / cancel / simulate; the Connect webhook settles it; no readers = simulated as before
//  - owner: overview, an order charged now (paid / payment_failed / not_for_sale / card_not_on_file)
//  - ops orders: cross-tenant list, forward-only PATCH, cancel refunds; platform invoice webhook
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import Stripe from 'stripe'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, signPosToken, StripeService, uuidv7 } from '../src/platform'

const ACCOUNT = 'acct_e2e_readers'
const CONNECT_SECRET = 'whsec_connect_readers'
const PLATFORM_SECRET = 'whsec_platform_readers'
const OPERATOR_EMAIL = 'card-readers-operator@restiq.example'

interface ErrorBody {
  error: { code: string; message: string }
}
interface ReaderBody {
  id: string
  outletId: string
  outletName: string
  label: string
  deviceType: string
  status: string
  simulated: boolean
}
interface IntentBody {
  id: string
  provider: string
  status: string
  failureReason: string | null
  providerRef: string | null
  readerId: string | null
  readerLabel: string | null
  tenderId: string | null
}
interface OrderBody {
  id: string
  tenantName: string
  outletName: string
  displayName: string
  quantity: number
  unitPriceMinor: string
  totalMinor: string
  currency: string
  status: string
  failureMessage: string | null
  trackingRef: string | null
}

type FakePi = { id: string; object: 'payment_intent'; amount: number; currency: string; status: Stripe.PaymentIntent.Status; metadata: Record<string, string>; last_payment_error: { message: string; decline_code?: string } | null }
type FakeReader = { id: string; object: 'terminal.reader'; device_type: string; serial_number: string; status: 'online' | 'offline'; label: string; action: { type: string; status: string; failure_message: string | null; process_payment_intent?: { payment_intent: string } } | null }

/** Just enough of Stripe for #286, recording every call. */
class FakeStripe {
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly intents = new Map<string, FakePi>()
  readonly readers = new Map<string, FakeReader>()
  payFails: string | null = null
  private n = 0
  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args })
  }
  readonly paymentIntents = {
    create: (params: { amount: number; currency: string; metadata: Record<string, string> }, options: unknown) => {
      this.record('paymentIntents.create', params, options)
      const pi: FakePi = { id: `pi_r_${++this.n}`, object: 'payment_intent', amount: params.amount, currency: params.currency, status: 'requires_payment_method', metadata: params.metadata, last_payment_error: null }
      this.intents.set(pi.id, pi)
      return Promise.resolve(pi)
    },
    retrieve: (id: string) => Promise.resolve({ ...this.intents.get(id) }),
    cancel: (id: string, _p: unknown, options: unknown) => {
      this.record('paymentIntents.cancel', id, options)
      const pi = this.intents.get(id)!
      if (pi.status === 'succeeded') return Promise.reject(new Stripe.errors.StripeInvalidRequestError({ message: 'already succeeded', type: 'invalid_request_error' }))
      pi.status = 'canceled'
      return Promise.resolve(pi)
    },
  }
  readonly terminal = {
    locations: {
      create: (params: unknown, options: unknown) => {
        this.record('locations.create', params, options)
        return Promise.resolve({ id: `tml_${++this.n}` })
      },
      del: (id: string) => Promise.resolve({ id, deleted: true }),
    },
    readers: {
      create: (params: { registration_code: string; label: string; location: string }, options: unknown) => {
        this.record('readers.create', params, options)
        if (params.registration_code === 'bad-code') return Promise.reject(new Stripe.errors.StripeInvalidRequestError({ message: 'Invalid registration code', type: 'invalid_request_error' }))
        const reader: FakeReader = { id: `tmr_${++this.n}`, object: 'terminal.reader', device_type: 'simulated_wisepos_e', serial_number: `SN${this.n}`, status: 'online', label: params.label, action: null }
        this.readers.set(reader.id, reader)
        return Promise.resolve(reader)
      },
      list: () => Promise.resolve({ data: [...this.readers.values()] }),
      retrieve: (id: string) => Promise.resolve(this.readers.get(id)),
      del: (id: string, _p: unknown, options: unknown) => {
        this.record('readers.del', id, options)
        this.readers.delete(id)
        return Promise.resolve({ id, deleted: true })
      },
      processPaymentIntent: (id: string, params: { payment_intent: string }, options: unknown) => {
        this.record('readers.processPaymentIntent', id, params, options)
        const reader = this.readers.get(id)!
        reader.action = { type: 'process_payment_intent', status: 'in_progress', failure_message: null, process_payment_intent: { payment_intent: params.payment_intent } }
        return Promise.resolve(reader)
      },
      cancelAction: (id: string, _p: unknown, options: unknown) => {
        this.record('readers.cancelAction', id, options)
        const reader = this.readers.get(id)
        if (reader) reader.action = null
        return Promise.resolve(reader)
      },
    },
  }
  readonly testHelpers = {
    terminal: {
      readers: {
        presentPaymentMethod: (id: string, params: { card_present: { number: string } }) => {
          this.record('presentPaymentMethod', id, params)
          const reader = this.readers.get(id)!
          const pi = this.intents.get(reader.action!.process_payment_intent!.payment_intent)!
          if (params.card_present.number === '4242424242424242') {
            pi.status = 'succeeded'
            reader.action!.status = 'succeeded'
          } else {
            pi.last_payment_error = { message: 'Your card was declined.', decline_code: 'generic_decline' }
            reader.action = { ...reader.action!, status: 'failed', failure_message: 'Your card was declined.' }
          }
          return Promise.resolve(reader)
        },
      },
    },
  }
  readonly subscriptions = { retrieve: () => Promise.resolve({ id: 'sub_e2e', default_payment_method: 'pm_card_e2e' }) }
  readonly customers = { retrieve: () => Promise.resolve({ id: 'cus_e2e', invoice_settings: { default_payment_method: null } }) }
  readonly invoices = {
    create: (params: unknown, options: unknown) => {
      this.record('invoices.create', params, options)
      return Promise.resolve({ id: `in_${++this.n}`, status: 'draft' })
    },
    finalizeInvoice: (id: string) => Promise.resolve({ id, status: 'open' }),
    pay: (id: string) => {
      this.record('invoices.pay', id)
      if (this.payFails) return Promise.reject(new Stripe.errors.StripeCardError({ message: this.payFails, type: 'card_error' }))
      return Promise.resolve({ id, status: 'paid' })
    },
    retrieve: (id: string) => Promise.resolve({ id, payments: { data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: `pi_platform_${id}` } }] } }),
  }
  readonly invoiceItems = {
    create: (params: unknown, options: unknown) => {
      this.record('invoiceItems.create', params, options)
      return Promise.resolve({ id: 'ii_1' })
    },
  }
  readonly refunds = {
    create: (params: unknown, options: unknown) => {
      this.record('refunds.create', params, options)
      return Promise.resolve({ id: 're_1' })
    },
  }
  method(name: string) {
    return this.calls.filter((c) => c.method === name)
  }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.readerOrder.deleteMany()
  await prisma.cardReader.deleteMany()
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
  await prisma.cashMovement.deleteMany()
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
  await prisma.tenantPaymentAccount.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

describe('#286 card readers and reader orders (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let stripe: FakeStripe
  let opsToken: string
  const saved = { sk: process.env.STRIPE_SECRET_KEY, connect: process.env.STRIPE_CONNECT_WEBHOOK_SECRET, platform: process.env.STRIPE_WEBHOOK_SECRET, sim: process.env.PAYMENTS_SIMULATOR }
  const signer = new Stripe('sk_test_never_called')

  beforeAll(async () => {
    prisma = createPrismaClient()
    process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET
    process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET
    await prisma.operatorUser.deleteMany({ where: { email: OPERATOR_EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })
    const real = new StripeService()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue({ client: () => stripe, constructEvent: real.constructEvent.bind(real) })
      .compile()
    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await wipe(prisma)
    await prisma.readerPrice.updateMany({ data: { priceMinor: null } })
    await app.close()
    await prisma.$disconnect()
    for (const [name, value] of [['STRIPE_SECRET_KEY', saved.sk], ['STRIPE_CONNECT_WEBHOOK_SECRET', saved.connect], ['STRIPE_WEBHOOK_SECRET', saved.platform], ['PAYMENTS_SIMULATOR', saved.sim]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  beforeEach(async () => {
    stripe = new FakeStripe()
    process.env.PAYMENTS_SIMULATOR = 'off'
    await wipe(prisma)
  })

  const ops = (req: request.Test) => req.set('Authorization', `Bearer ${opsToken}`)
  const authed = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`)

  async function tenant(opts: { country?: 'AU' | 'IN'; live?: boolean; active?: boolean; name?: string } = {}) {
    const tenantId = uuidv7()
    const country = opts.country ?? 'IN'
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: opts.name ?? 'Reader Co',
        registeredAddress: '1 Test Street',
        contactName: 'Test',
        contactEmail: 'contact@test.example',
        contactPhone: '+91 90000 00000',
        country,
        status: 'active',
        plan: 'standard',
        billingPeriod: 'monthly',
        liveSince: opts.live === false ? null : new Date(Date.now() - 60_000),
      },
    })
    await prisma.tenantPaymentAccount.create({ data: { tenantId, stripeAccountId: `${ACCOUNT}_${tenantId.slice(-6)}`, cardPaymentsActive: opts.active ?? true, feePercentBps: 250, feeFixedMinor: 30n } })
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Brand' } })
    const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Main', address: 'A1', type: 'dine_in', timezone: country === 'AU' ? 'Australia/Sydney' : 'Asia/Kolkata' } })
    return { tenantId, outletId: outlet.id, accountId: `${ACCOUNT}_${tenantId.slice(-6)}` }
  }

  function register(tenantId: string, body: object) {
    return ops(request(httpServer).post(`/ops/v1/tenants/${tenantId}/card-readers`)).send(body)
  }
  const ADDRESS = { line1: '1 MG Road', city: 'Bengaluru', state: 'KA', postcode: '560001' }

  /** An IN tenant with an open 2 x 10000 bill, a cashier and (optionally) one registered reader. */
  async function openBill(opts: { live?: boolean; reader?: boolean } = {}) {
    const t = await tenant({ live: opts.live })
    const floor = await prisma.floor.create({ data: { tenantId: t.tenantId, outletId: t.outletId, name: 'Ground' } })
    const table = await prisma.diningTable.create({ data: { tenantId: t.tenantId, floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 } })
    const role = await prisma.role.create({ data: { tenantId: t.tenantId, name: 'Cashier', isSystem: true, isManager: false } })
    const staff = await prisma.staffUser.create({ data: { tenantId: t.tenantId, roleId: role.id, name: 'Asha' } })
    await prisma.shift.create({ data: { tenantId: t.tenantId, outletId: t.outletId, openedByStaffId: staff.id, floatMinor: 0n } })
    const token = signPosToken({ sessionVersion: 0, id: staff.id, tenantId: t.tenantId, outletId: t.outletId, name: 'Asha' })
    const category = await prisma.menuCategory.create({ data: { tenantId: t.tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId: t.tenantId, categoryId: category.id, name: 'Dish', shortName: 'D' } })
    await prisma.itemPrice.create({ data: { tenantId: t.tenantId, itemId: item.id, priceMinor: 10000n, currency: 'INR', channel: 'dine_in' } })
    const opened = await authed(request(httpServer).post(`/pos/v1/outlets/${t.outletId}/tables/${table.id}/order`), token).send()
    const orderId = (opened.body as { id: string }).id
    await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), token).send({ itemId: item.id, quantity: 2 })
    await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), token).send({ status: 'sent' })
    const bill = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/bill`), token).send()
    expect(bill.status, JSON.stringify(bill.body)).toBe(201)
    let reader: ReaderBody | null = null
    if (opts.reader !== false) {
      const res = await register(t.tenantId, { outletId: t.outletId, label: 'Front counter', registrationCode: 'simulated-wpe', address: ADDRESS })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      reader = (res.body as { reader: ReaderBody }).reader
    }
    const { totalMinor } = bill.body as { id: string; totalMinor: number }
    return { ...t, token, billId: (bill.body as { id: string }).id, totalMinor, reader }
  }

  function sendToReader(billId: string, token: string, amountMinor: number, readerId?: string) {
    return authed(request(httpServer).post(`/pos/v1/bills/${billId}/intents`), token).send({ rail: 'card_terminal', amountMinor, clientKey: uuidv7(), ...(readerId ? { readerId } : {}) })
  }

  describe('ops: prices and readers', () => {
    it('lists every country x model and sets a price with a reason (null = not for sale)', async () => {
      const list = await ops(request(httpServer).get('/ops/v1/reader-prices'))
      expect(list.status).toBe(200)
      expect((list.body as { prices: unknown[] }).prices).toHaveLength(4)
      const put = await ops(request(httpServer).put('/ops/v1/reader-prices/AU/s700')).send({ priceMinor: 29900, reason: 'Launch price' })
      expect(put.status, JSON.stringify(put.body)).toBe(200)
      expect(put.body).toMatchObject({ price: { country: 'AU', model: 's700', displayName: 'Stripe Reader S700', priceMinor: '29900', currency: 'AUD' } })
      expect((await prisma.controlPlaneAuditEvent.findFirst({ where: { action: 'reader_price.updated' }, orderBy: { occurredAt: 'desc' } }))?.reason).toContain('Launch price')
      expect((await ops(request(httpServer).put('/ops/v1/reader-prices/AU/s700')).send({ priceMinor: 1 })).status).toBe(400)
      expect((await ops(request(httpServer).put('/ops/v1/reader-prices/US/s700')).send({ priceMinor: 1, reason: 'x' })).status).toBe(400)
      expect((await request(httpServer).get('/ops/v1/reader-prices')).status).toBe(401)
    })

    it('registers readers (first one makes the Terminal Location), lists live status, removes at Stripe too', async () => {
      const t = await tenant()
      const missing = await register(t.tenantId, { outletId: t.outletId, label: 'Front', registrationCode: 'simulated-wpe' })
      expect(missing.status).toBe(409)
      expect((missing.body as ErrorBody).error.code).toBe('address_required')

      const bad = await register(t.tenantId, { outletId: t.outletId, label: 'Front', registrationCode: 'bad-code', address: ADDRESS })
      expect(bad.status).toBe(400)
      expect((bad.body as ErrorBody).error.message).toBe('Invalid registration code')

      const first = await register(t.tenantId, { outletId: t.outletId, label: 'Front', registrationCode: 'simulated-wpe', address: ADDRESS })
      expect(first.status, JSON.stringify(first.body)).toBe(201)
      expect((first.body as { reader: ReaderBody }).reader).toMatchObject({ outletId: t.outletId, outletName: 'Main', label: 'Front', deviceType: 'simulated_wisepos_e', status: 'online', simulated: true })
      // The bad-code attempt already made the location; it is reused, not made twice.
      expect(stripe.method('locations.create')).toHaveLength(1)
      expect(stripe.method('locations.create')[0].args).toEqual([
        { display_name: 'Main', address: { line1: '1 MG Road', city: 'Bengaluru', state: 'KA', postal_code: '560001', country: 'IN' }, metadata: { tenantId: t.tenantId, outletId: t.outletId } },
        { stripeAccount: t.accountId },
      ])
      const location = (await prisma.outlet.findUniqueOrThrow({ where: { id: t.outletId } })).stripeTerminalLocationId
      expect(location).toMatch(/^tml_/)

      const second = await register(t.tenantId, { outletId: t.outletId, label: 'Bar', registrationCode: 'simulated-wpe' })
      expect(second.status).toBe(201)
      expect(stripe.method('readers.create').at(-1)?.args[0]).toMatchObject({ location })

      const listed = await ops(request(httpServer).get(`/ops/v1/tenants/${t.tenantId}/card-readers`))
      expect((listed.body as { readers: ReaderBody[] }).readers.map((r) => r.label)).toEqual(['Front', 'Bar'])

      const readerId = (first.body as { reader: ReaderBody }).reader.id
      expect((await ops(request(httpServer).delete(`/ops/v1/tenants/${t.tenantId}/card-readers/${readerId}`)).send({})).status).toBe(400)
      const removed = await ops(request(httpServer).delete(`/ops/v1/tenants/${t.tenantId}/card-readers/${readerId}`)).send({ reason: 'Broken screen' })
      expect(removed.status).toBe(204)
      expect(stripe.method('readers.del')).toHaveLength(1)
      expect(await prisma.cardReader.count({ where: { tenantId: t.tenantId } })).toBe(1)
      expect(await prisma.auditEvent.findFirst({ where: { tenantId: t.tenantId, action: 'card_reader.removed' } })).toMatchObject({ reason: expect.stringContaining('Broken screen') as string })
    })

    it('409 provider_unavailable without an active Stripe account', async () => {
      const t = await tenant({ active: false })
      const res = await register(t.tenantId, { outletId: t.outletId, label: 'Front', registrationCode: 'simulated-wpe', address: ADDRESS })
      expect(res.status).toBe(409)
      expect((res.body as ErrorBody).error.code).toBe('provider_unavailable')
    })
  })

  describe('POS: card_terminal on a Stripe reader', () => {
    it('lists the outlet readers; a reader is required; the PaymentIntent runs on the reader; GET settles it once', async () => {
      const b = await openBill()
      const readers = await authed(request(httpServer).get(`/pos/v1/outlets/${b.outletId}/card-readers`), b.token)
      expect(readers.status).toBe(200)
      expect((readers.body as { readers: ReaderBody[] }).readers).toEqual([expect.objectContaining({ id: b.reader!.id, label: 'Front counter', status: 'online' })])

      const noReader = await sendToReader(b.billId, b.token, b.totalMinor)
      expect(noReader.status).toBe(400)
      expect((noReader.body as ErrorBody).error.code).toBe('reader_required')

      const res = await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const intent = res.body as IntentBody
      expect(intent).toMatchObject({ provider: 'stripe', status: 'pending', providerRef: 'pi_r_3', readerId: b.reader!.id, readerLabel: 'Front counter' })
      expect(stripe.method('paymentIntents.create')[0].args).toEqual([
        { amount: b.totalMinor, currency: 'inr', allowed_payment_method_types: ['card_present'], capture_method: 'automatic', application_fee_amount: Math.round((b.totalMinor * 250) / 10_000) + 30, metadata: { tenantId: b.tenantId, billId: b.billId, intentId: intent.id } },
        { stripeAccount: b.accountId, idempotencyKey: `restiq-pos-terminal-${intent.id}` },
      ])
      expect(stripe.method('readers.processPaymentIntent')[0].args.slice(1, 2)).toEqual([{ payment_intent: 'pi_r_3' }])

      // Never in the simulated terminal's queue.
      const queue = await authed(request(httpServer).get(`/pos/v1/outlets/${b.outletId}/payment-intents`), b.token)
      expect(queue.body).toEqual([])

      // Still on the reader: GET changes nothing.
      expect(((await authed(request(httpServer).get(`/pos/v1/payment-intents/${intent.id}`), b.token)).body as IntentBody).status).toBe('pending')

      // A reloaded settle screen finds the still-waiting payment on its bill.
      const active = await authed(request(httpServer).get(`/pos/v1/bills/${b.billId}/intents/active`), b.token)
      expect(active.body).toMatchObject({ intent: { id: intent.id, status: 'pending', readerId: expect.any(String) as string } })

      stripe.intents.get('pi_r_3')!.status = 'succeeded'
      for (let i = 0; i < 2; i++) {
        const got = await authed(request(httpServer).get(`/pos/v1/payment-intents/${intent.id}`), b.token)
        expect(got.body).toMatchObject({ status: 'succeeded', tenderId: expect.any(String) as string })
      }
      const tenders = await prisma.tender.findMany({ where: { billId: b.billId } })
      expect(tenders).toEqual([expect.objectContaining({ method: 'card_terminal', amountMinor: BigInt(b.totalMinor), paymentIntentId: intent.id })])
      // Settled: nothing left to resume.
      expect((await authed(request(httpServer).get(`/pos/v1/bills/${b.billId}/intents/active`), b.token)).body).toEqual({ intent: null })
      const finalize = await authed(request(httpServer).post(`/pos/v1/bills/${b.billId}/finalize`), b.token).send({ tenders: [] })
      expect(finalize.status, JSON.stringify(finalize.body)).toBe(200)
    })

    it('simulate (test key): failure declines with Stripe\'s message, then success on a fresh intent settles', async () => {
      const b = await openBill()
      const first = (await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)).body as IntentBody
      const declined = await authed(request(httpServer).post(`/pos/v1/payment-intents/${first.id}/simulate`), b.token).send({ outcome: 'failure' })
      expect(declined.status, JSON.stringify(declined.body)).toBe(200)
      expect(declined.body).toMatchObject({ status: 'failed', failureReason: 'Your card was declined.' })
      expect(stripe.intents.get(first.providerRef!)?.status).toBe('canceled')

      const second = (await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)).body as IntentBody
      const approved = await authed(request(httpServer).post(`/pos/v1/payment-intents/${second.id}/simulate`), b.token).send({ outcome: 'success' })
      expect(approved.body).toMatchObject({ status: 'succeeded', tenderId: expect.any(String) as string })
      expect(stripe.method('presentPaymentMethod').map((c) => (c.args[1] as { card_present: { number: string } }).card_present.number)).toEqual(['4000000000000002', '4242424242424242'])
    })

    it('a reader action that failed without a decline fails the intent with the reader\'s message', async () => {
      const b = await openBill()
      const intent = (await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)).body as IntentBody
      const reader = [...stripe.readers.values()][0]
      reader.action = { ...reader.action!, status: 'failed', failure_message: 'Customer cancelled on the reader' }
      const got = await authed(request(httpServer).get(`/pos/v1/payment-intents/${intent.id}`), b.token)
      expect(got.body).toMatchObject({ status: 'failed', failureReason: 'Customer cancelled on the reader' })
    })

    it('cancel clears the reader and cancels the PaymentIntent; one that already went through is settled instead', async () => {
      const b = await openBill()
      const intent = (await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)).body as IntentBody
      const cancelled = await authed(request(httpServer).post(`/pos/v1/payment-intents/${intent.id}/cancel`), b.token).send()
      expect(cancelled.body).toMatchObject({ status: 'cancelled', failureReason: 'cancelled_by_staff' })
      expect(stripe.method('readers.cancelAction')).toHaveLength(1)
      expect(stripe.intents.get(intent.providerRef!)?.status).toBe('canceled')

      const paid = (await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)).body as IntentBody
      stripe.intents.get(paid.providerRef!)!.status = 'succeeded'
      const late = await authed(request(httpServer).post(`/pos/v1/payment-intents/${paid.id}/cancel`), b.token).send()
      expect(late.status).toBe(409)
      expect((late.body as ErrorBody).error.code).toBe('already_succeeded')
      expect(await prisma.tender.count({ where: { billId: b.billId } })).toBe(1)
    })

    it('a reader refusing the payment (offline, busy) fails the intent with Stripe\'s message', async () => {
      const b = await openBill()
      stripe.terminal.readers.processPaymentIntent = () => Promise.reject(new Stripe.errors.StripeInvalidRequestError({ message: 'Reader is currently offline', type: 'invalid_request_error' }))
      const res = await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)
      expect(res.body).toMatchObject({ status: 'failed', failureReason: 'Reader is currently offline' })
      expect(stripe.intents.get((res.body as IntentBody).providerRef!)?.status).toBe('canceled')
    })

    it('the Connect webhook settles a POS reader intent with one tender', async () => {
      const b = await openBill()
      const intent = (await sendToReader(b.billId, b.token, b.totalMinor, b.reader!.id)).body as IntentBody
      const pi = stripe.intents.get(intent.providerRef!)!
      pi.status = 'succeeded'
      for (let i = 0; i < 2; i++) {
        const payload = JSON.stringify({ id: `evt_${i}`, object: 'event', type: 'payment_intent.succeeded', account: b.accountId, data: { object: pi } })
        const res = await request(httpServer).post('/webhooks/stripe/connect').set('Content-Type', 'application/json').set('Stripe-Signature', signer.webhooks.generateTestHeaderString({ payload, secret: CONNECT_SECRET })).send(payload)
        expect(res.body).toEqual({ received: true, result: 'applied' })
      }
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'succeeded' })
      expect(await prisma.tender.count({ where: { billId: b.billId, method: 'card_terminal' } })).toBe(1)
      // The POS still finalises (the webhook does not complete the bill for staff).
      expect((await prisma.bill.findUniqueOrThrow({ where: { id: b.billId } })).status).toBe('open')
    })

    it('without readers, or in Test mode, the simulated terminal is unchanged', async () => {
      process.env.PAYMENTS_SIMULATOR = 'on'
      for (const opts of [{ reader: false }, { live: false }]) {
        await wipe(prisma)
        const b = await openBill(opts)
        await prisma.device.create({ data: { tenantId: b.tenantId, outletId: b.outletId, label: 'Terminal', type: 'terminal', hardwareKeyFingerprint: `fp-${uuidv7()}`, enrolledAt: new Date() } })
        expect((await authed(request(httpServer).get(`/pos/v1/outlets/${b.outletId}/card-readers`), b.token)).body).toEqual({ readers: [] })
        const res = await sendToReader(b.billId, b.token, b.totalMinor, b.reader?.id)
        expect(res.status, JSON.stringify(res.body)).toBe(201)
        expect(res.body).toMatchObject({ provider: 'simulated', readerId: null, client: { simulated: true } })
      }
      expect(stripe.method('paymentIntents.create')).toHaveLength(0)
    })
  })

  describe('reader orders', () => {
    async function auTenantWithCard(opts: { card?: boolean; name?: string } = {}) {
      const t = await tenant({ country: 'AU', name: opts.name })
      if (opts.card !== false) {
        await prisma.subscription.create({
          data: { tenantId: t.tenantId, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86_400_000), stripeCustomerId: 'cus_e2e', stripeSubscriptionId: `sub_${t.tenantId}`, cardBillingStatus: 'active' },
        })
      }
      const ownerToken = signAdminToken({ id: uuidv7(), tenantId: t.tenantId, email: 'owner@test.example' })
      return { ...t, ownerToken }
    }
    const SHIPPING = { name: 'Asha', line1: '1 George St', city: 'Sydney', state: 'NSW', postcode: '2000', phone: '+61 400 000 000' }
    const order = (token: string, body: object) => authed(request(httpServer).post('/admin/v1/reader-orders'), token).send(body)

    beforeEach(async () => {
      await prisma.readerPrice.updateMany({ data: { priceMinor: null } })
      await prisma.readerPrice.update({ where: { country_model: { country: 'AU', model: 's700' } }, data: { priceMinor: 29900n } })
    })

    it('owner overview: own-country priced models, cardOnFile, readers and orders', async () => {
      const t = await auTenantWithCard()
      const res = await authed(request(httpServer).get('/admin/v1/card-readers'), t.ownerToken)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body).toMatchObject({ readers: [], cardOnFile: true, orders: [], prices: [{ country: 'AU', model: 's700', priceMinor: '29900', currency: 'AUD' }] })
      const none = await auTenantWithCard({ card: false })
      expect((await authed(request(httpServer).get('/admin/v1/card-readers'), none.ownerToken)).body).toMatchObject({ cardOnFile: false })
    })

    it('an order is charged now: invoice on the platform customer with the subscription card -> paid', async () => {
      const t = await auTenantWithCard()
      const res = await order(t.ownerToken, { outletId: t.outletId, model: 's700', quantity: 2, shipping: SHIPPING })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const placed = (res.body as { order: OrderBody }).order
      expect(placed).toMatchObject({ status: 'paid', quantity: 2, unitPriceMinor: '29900', totalMinor: '59800', currency: 'AUD', displayName: 'Stripe Reader S700', failureMessage: null })
      expect(stripe.method('invoices.create')[0].args).toEqual([
        { customer: 'cus_e2e', currency: 'aud', collection_method: 'charge_automatically', default_payment_method: 'pm_card_e2e', auto_advance: false, pending_invoice_items_behavior: 'exclude', description: 'Restiq card readers', metadata: { tenantId: t.tenantId, readerOrderId: placed.id } },
        { idempotencyKey: `restiq-reader-order-${placed.id}-invoice` },
      ])
      expect(stripe.method('invoiceItems.create')[0].args[0]).toMatchObject({ amount: 59800, currency: 'aud', description: '2 x Stripe Reader S700' })
    })

    it('a declined card -> payment_failed with the message; webhook invoice.paid later marks it paid', async () => {
      const t = await auTenantWithCard()
      stripe.payFails = 'Your card has insufficient funds.'
      const res = await order(t.ownerToken, { outletId: t.outletId, model: 's700', quantity: 1, shipping: SHIPPING })
      const placed = (res.body as { order: OrderBody }).order
      expect(placed).toMatchObject({ status: 'payment_failed', failureMessage: 'Your card has insufficient funds.' })
      const row = await prisma.readerOrder.findUniqueOrThrow({ where: { id: placed.id } })

      const invoice = { id: row.stripeInvoiceId, object: 'invoice', currency: 'aud', amount_paid: 29900, metadata: { tenantId: t.tenantId, readerOrderId: placed.id } }
      const payload = JSON.stringify({ id: 'evt_inv', object: 'event', type: 'invoice.paid', data: { object: invoice } })
      const hook = await request(httpServer).post('/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', signer.webhooks.generateTestHeaderString({ payload, secret: PLATFORM_SECRET })).send(payload)
      expect(hook.body).toEqual({ received: true, result: 'applied' })
      expect(await prisma.readerOrder.findUniqueOrThrow({ where: { id: placed.id } })).toMatchObject({ status: 'paid', failureMessage: null })
      // Not a subscription invoice: nothing written to invoices.
      expect(await prisma.invoice.count({ where: { tenantId: t.tenantId } })).toBe(0)
    })

    it('409 not_for_sale and card_not_on_file; 400 for a bad quantity or shipping', async () => {
      const t = await auTenantWithCard()
      expect(((await order(t.ownerToken, { outletId: t.outletId, model: 'wisepos_e', quantity: 1, shipping: SHIPPING })).body as ErrorBody).error.code).toBe('not_for_sale')
      expect((await order(t.ownerToken, { outletId: t.outletId, model: 's700', quantity: 6, shipping: SHIPPING })).status).toBe(400)
      expect((await order(t.ownerToken, { outletId: t.outletId, model: 's700', quantity: 1, shipping: { ...SHIPPING, postcode: ' ' } })).status).toBe(400)
      expect((await order(t.ownerToken, { outletId: t.outletId, model: 's700', quantity: 1 })).status).toBe(400)
      const none = await auTenantWithCard({ card: false })
      expect(((await order(none.ownerToken, { outletId: none.outletId, model: 's700', quantity: 1, shipping: SHIPPING })).body as ErrorBody).error.code).toBe('card_not_on_file')
      expect(stripe.method('invoices.create')).toHaveLength(0)
    })

    it('ops: cross-tenant list, forward-only PATCH, cancel refunds the platform payment', async () => {
      const a = await auTenantWithCard({ name: 'Alpha' })
      const b = await auTenantWithCard({ name: 'Beta' })
      const oa = ((await order(a.ownerToken, { outletId: a.outletId, model: 's700', quantity: 1, shipping: SHIPPING })).body as { order: OrderBody }).order
      await order(b.ownerToken, { outletId: b.outletId, model: 's700', quantity: 1, shipping: SHIPPING })

      const all = (await ops(request(httpServer).get('/ops/v1/reader-orders?status=paid'))).body as { orders: OrderBody[] }
      expect(all.orders.map((o) => o.tenantName).sort()).toEqual(['Alpha', 'Beta'])
      expect(((await ops(request(httpServer).get(`/ops/v1/tenants/${a.tenantId}/reader-orders`))).body as { orders: OrderBody[] }).orders).toHaveLength(1)
      expect((await ops(request(httpServer).get('/ops/v1/reader-orders?status=bogus'))).status).toBe(400)

      const patch = (body: object) => ops(request(httpServer).patch(`/ops/v1/reader-orders/${oa.id}`)).send(body)
      expect(((await patch({ status: 'shipped', reason: 'x' })).body as ErrorBody).error.code).toBe('invalid_transition')
      expect((await patch({ status: 'ordered', reason: 'Placed with Stripe' })).body).toMatchObject({ order: { status: 'ordered' } })
      const cancelled = await patch({ status: 'cancelled', opsNote: 'Out of stock', reason: 'Supplier delay' })
      expect(cancelled.body).toMatchObject({ order: { status: 'cancelled' } })
      expect(stripe.method('refunds.create')[0].args).toEqual([{ payment_intent: expect.stringMatching(/^pi_platform_in_/) as string, metadata: { readerOrderId: oa.id, tenantId: a.tenantId } }, { idempotencyKey: `restiq-reader-order-refund-${oa.id}` }])
      expect(((await patch({ status: 'ordered', reason: 'x' })).body as ErrorBody).error.code).toBe('invalid_transition')
    })
  })
})
