// CAP-5 success criteria, end to end: suspend/reactivate round-trips without
// data loss; the grace window is read from config, not hardcoded; every
// mutation requires a reason.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import Stripe from 'stripe'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signOpsToken, uuidv7 } from '../src/platform'

const EMAIL = 'subscription-operator@restiq.example'

interface SubscriptionView {
  tenantId: string
  status: string
  plan: string
  billingPeriod: string
  currentPeriodStart: string
  currentPeriodEnd: string
  suspendedAt: string | null
  graceWindowHours: number
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
  // shifts/cash_movements (pos/CAP-10) restrict-delete tenants/outlets/staff;
  // wiped first for the same reason invoice/subscription is below.
  await prisma.cashMovement.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.tenantPaymentAccount.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.subscription.deleteMany()
  await prisma.billingLineItem.deleteMany()
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
  await prisma.billShare.deleteMany()
  await prisma.tender.deleteMany()
  await prisma.paymentIntent.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
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

describe('/ops/v1/tenants/:tenantId/subscription (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let token: string
  let operatorId: string
  let tenantId: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: EMAIL } })
    const operator = await prisma.operatorUser.create({
      data: { email: EMAIL, passwordHash: await argon2.hash('irrelevant-here') },
    })
    operatorId = operator.id
    token = signOpsToken({ id: operator.id, email: operator.email })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    // rawBody: as main.ts - the Stripe webhook verifies its signature over the raw bytes.
    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    // Other suites delete tenants; a leftover payments row would block them (FK).
    await prisma.tenantPaymentAccount.deleteMany()
    await prisma.billingLineItem.deleteMany()
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
    tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Spice Route Hospitality',
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
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
    await prisma.outlet.create({
      data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })
    await prisma.device.create({
      data: {
        tenantId,
        label: 'Terminal 1',
        type: 'pos',
        hardwareKeyFingerprint: 'fp-1',
        enrolledAt: new Date(),
      },
    })
  })

  afterEach(() => {
    delete process.env.SUSPENSION_GRACE_HOURS
  })

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  function subOf(res: request.Response): SubscriptionView {
    return (res.body as { subscription: SubscriptionView }).subscription
  }

  function errorCodeOf(res: request.Response): string {
    return (res.body as { error: { code: string } }).error.code
  }

  async function suspend(reason?: string) {
    return authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/subscription/suspend`)).send(
      reason === undefined ? {} : { reason },
    )
  }

  async function reactivate(reason?: string) {
    return authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/subscription/reactivate`)).send(
      reason === undefined ? {} : { reason },
    )
  }

  describe('GET /ops/v1/tenants/:tenantId/subscription', () => {
    it('returns a default active subscription for a tenant that has never been mutated', async () => {
      const res = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`))
      expect(res.status).toBe(200)
      const body = res.body as SubscriptionView
      expect(body).toMatchObject({ tenantId, status: 'active', plan: 'standard', billingPeriod: 'monthly', suspendedAt: null })
      expect(await prisma.subscription.count({ where: { tenantId } })).toBe(0)
    })

    it('reads the grace window from config, not a hardcoded value', async () => {
      const withDefault = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`))
      expect((withDefault.body as SubscriptionView).graceWindowHours).toBe(72)

      process.env.SUSPENSION_GRACE_HOURS = '10'
      const withOverride = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`))
      expect((withOverride.body as SubscriptionView).graceWindowHours).toBe(10)
    })

    it('404s for an unknown tenant', async () => {
      const res = await authed(request(httpServer).get(`/ops/v1/tenants/${uuidv7()}/subscription`))
      expect(res.status).toBe(404)
    })

    it('rejects without an ops token', async () => {
      const res = await request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`)
      expect(res.status).toBe(401)
    })
  })

  describe('GET /ops/v1/tenants/:tenantId/subscription/invoices', () => {
    it('lists invoices newest-first', async () => {
      const subRow = await prisma.subscription.create({
        data: { tenantId, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date() },
      })
      await prisma.invoice.create({
        data: { tenantId, subscriptionId: subRow.id, period: '2026-07', amountMinor: 60000n, status: 'paid' },
      })
      await prisma.invoice.create({
        data: { tenantId, subscriptionId: subRow.id, period: '2026-08', amountMinor: 60000n, status: 'pending' },
      })

      const res = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription/invoices`))
      expect(res.status).toBe(200)
      const body = res.body as { invoices: Array<{ period: string; amountMinor: string; status: string }> }
      expect(body.invoices).toHaveLength(2)
      expect(body.invoices[0]).toMatchObject({ period: '2026-08', amountMinor: '60000', status: 'pending' })
    })
  })

  describe('POST /ops/v1/tenants/:tenantId/subscription/suspend', () => {
    it('suspends immediately, audited, sets suspendedAt', async () => {
      const res = await suspend('Non-payment beyond arrears window')
      expect(res.status).toBe(200)
      const body = subOf(res)
      expect(body.status).toBe('suspended')
      expect(body.suspendedAt).not.toBeNull()

      const row = await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })
      expect(row.status).toBe('suspended')

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'subscription.suspended' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ actorId: operatorId, actorEmail: EMAIL, reason: 'Non-payment beyond arrears window' })
    })

    it('rejects without a reason and writes nothing', async () => {
      const before = await prisma.auditEvent.count()
      const res = await suspend()
      expect(res.status).toBe(400)
      expect(await prisma.subscription.count({ where: { tenantId } })).toBe(0)
      expect(await prisma.auditEvent.count()).toBe(before)
    })

    it('suspending an already-suspended subscription conflicts, not a silent no-op', async () => {
      await suspend('first')
      const again = await suspend('second')
      expect(again.status).toBe(409)
    })

    it('404s for an unknown tenant', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${uuidv7()}/subscription/suspend`)).send({ reason: 'x' })
      expect(res.status).toBe(404)
    })

    it('rejects without an ops token', async () => {
      const res = await request(httpServer).post(`/ops/v1/tenants/${tenantId}/subscription/suspend`).send({ reason: 'x' })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /ops/v1/tenants/:tenantId/subscription/reactivate', () => {
    it('round-trips suspend -> reactivate without losing any other tenant data', async () => {
      const outletsBefore = await prisma.outlet.findMany({ where: { tenantId } })
      const devicesBefore = await prisma.device.findMany({ where: { tenantId } })
      const tenantBefore = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })

      await suspend('Non-payment')
      const res = await reactivate('Payment received')
      expect(res.status).toBe(200)
      const body = subOf(res)
      expect(body.status).toBe('active')
      expect(body.suspendedAt).toBeNull()

      const outletsAfter = await prisma.outlet.findMany({ where: { tenantId } })
      const devicesAfter = await prisma.device.findMany({ where: { tenantId } })
      const tenantAfter = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })

      expect(outletsAfter).toEqual(outletsBefore)
      expect(devicesAfter).toEqual(devicesBefore)
      expect(tenantAfter).toEqual(tenantBefore)

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'subscription.reactivated' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ reason: 'Payment received' })
    })

    it('rejects without a reason', async () => {
      await suspend('first')
      const res = await reactivate()
      expect(res.status).toBe(400)
      expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).status).toBe('suspended')
    })

    it('reactivating a non-suspended subscription conflicts', async () => {
      const res = await reactivate('nothing to undo')
      expect(res.status).toBe(409)
      expect(errorCodeOf(res)).toBe('conflict')
    })

    it('404s for an unknown tenant', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${uuidv7()}/subscription/reactivate`)).send({ reason: 'x' })
      expect(res.status).toBe(404)
    })
  })

  // #282 Stripe Connect + card billing. Nothing here reaches Stripe: the routes
  // tested either never call it, or fail before the first call.
  describe('Stripe card billing and payments (#282)', () => {
    const saved = { key: process.env.STRIPE_SECRET_KEY, secret: process.env.STRIPE_WEBHOOK_SECRET }
    let savedPrice: { monthlyPriceMinor: bigint | null; annualDiscountPercent: number } | null

    beforeEach(async () => {
      savedPrice = await prisma.planPrice.findUnique({ where: { country_plan: { country: 'IN', plan: 'standard' } } })
    })

    afterEach(async () => {
      for (const [name, value] of [['STRIPE_SECRET_KEY', saved.key], ['STRIPE_WEBHOOK_SECRET', saved.secret]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (savedPrice) {
        const { monthlyPriceMinor, annualDiscountPercent } = savedPrice
        await prisma.planPrice.update({ where: { country_plan: { country: 'IN', plan: 'standard' } }, data: { monthlyPriceMinor, annualDiscountPercent } })
      } else {
        await prisma.planPrice.deleteMany({ where: { country: 'IN', plan: 'standard' } })
      }
    })

    function setPrice(monthlyPriceMinor: bigint | null, annualDiscountPercent = 20) {
      const data = { monthlyPriceMinor, annualDiscountPercent }
      return prisma.planPrice.upsert({ where: { country_plan: { country: 'IN', plan: 'standard' } }, create: { country: 'IN', plan: 'standard', ...data }, update: data })
    }

    it('the subscription view carries cardBilling from PlanPrice, per billing period', async () => {
      await setPrice(null)
      let res = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`))
      expect((res.body as { cardBilling: unknown }).cardBilling).toEqual({ status: 'not_set_up', amountMinor: null, currency: 'INR' })

      await setPrice(99900n, 20)
      res = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`))
      expect((res.body as { cardBilling: { amountMinor: string } }).cardBilling.amountMinor).toBe('99900')

      await prisma.tenant.update({ where: { id: tenantId }, data: { billingPeriod: 'annual' } })
      res = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`))
      expect((res.body as { cardBilling: { amountMinor: string } }).cardBilling.amountMinor).toBe('959040')
    })

    it('billing-link: 503 without a Stripe key, 409 price_not_set without a monthly price', async () => {
      delete process.env.STRIPE_SECRET_KEY
      let res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/subscription/billing-link`)).send({})
      expect(res.status).toBe(503)
      expect(errorCodeOf(res)).toBe('payments_not_configured')

      process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
      await setPrice(null)
      res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/subscription/billing-link`)).send({})
      expect(res.status).toBe(409)
      expect(errorCodeOf(res)).toBe('price_not_set')
    })

    it('billing-link: 409 conflict once card billing is active', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
      await prisma.subscription.create({
        data: { tenantId, currentPeriodStart: new Date(), currentPeriodEnd: new Date(), cardBillingStatus: 'active' },
      })
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/subscription/billing-link`)).send({})
      expect(res.status).toBe(409)
      expect(errorCodeOf(res)).toBe('conflict')
    })

    it('a signed webhook updates the tenant on its region plane; a bad signature is 400', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e'
      const payload = JSON.stringify({
        id: 'evt_e2e',
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: { object: 'checkout.session', mode: 'subscription', subscription: 'sub_e2e', customer: 'cus_e2e', metadata: { tenantId } } },
      })
      const stripe = new Stripe('sk_test_never_called')
      const bad = await request(httpServer)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' }))
        .send(payload)
      expect(bad.status).toBe(400)
      expect(await prisma.subscription.count({ where: { tenantId } })).toBe(0)

      const ok = await request(httpServer)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_e2e' }))
        .send(payload)
      expect(ok.status).toBe(200)
      expect(await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).toMatchObject({
        stripeSubscriptionId: 'sub_e2e',
        stripeCustomerId: 'cus_e2e',
        cardBillingStatus: 'active',
        status: 'active',
      })
    })

    it('GET payments defaults to not_connected with all methods and no fee, without touching Stripe', async () => {
      delete process.env.STRIPE_SECRET_KEY
      const res = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/payments`))
      expect(res.status).toBe(200)
      expect((res.body as { payments: unknown }).payments).toEqual({
        tenantId,
        stripeAccountId: null,
        status: 'not_connected',
        requirementsDue: 0,
        cardPaymentsActive: false,
        payoutsActive: false,
        detailsSubmitted: false,
        requirements: [],
        allowedMethods: ['card', 'apple_pay', 'google_pay'],
        feePercentBps: 0,
        feeFixedMinor: '0',
        currency: 'INR',
      })
    })

    it('PATCH payments saves the settings with an audited reason', async () => {
      const res = await authed(request(httpServer).patch(`/ops/v1/tenants/${tenantId}/payments`)).send({
        allowedMethods: ['card'],
        feePercentBps: 250,
        feeFixedMinor: '30',
        reason: 'Agreed platform fee',
      })
      expect(res.status).toBe(200)
      expect((res.body as { payments: unknown }).payments).toMatchObject({ allowedMethods: ['card'], feePercentBps: 250, feeFixedMinor: '30' })
      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'payments.updated' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ reason: 'Agreed platform fee', actorId: operatorId })
    })

    it('PATCH payments rejects a missing reason, no methods, or a bad fee', async () => {
      const url = `/ops/v1/tenants/${tenantId}/payments`
      for (const body of [
        { feePercentBps: 100 },
        { allowedMethods: [], reason: 'x' },
        { allowedMethods: ['cash'], reason: 'x' },
        { feePercentBps: 10_001, reason: 'x' },
        { feeFixedMinor: '-1', reason: 'x' },
        { feeFixedMinor: '1.5', reason: 'x' },
      ]) {
        const res = await authed(request(httpServer).patch(url)).send(body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
      expect(await prisma.tenantPaymentAccount.count({ where: { tenantId } })).toBe(0)
    })

    // #290 billing contracts.
    it('GET contract without items reports the plan price', async () => {
      await setPrice(99900n)
      const res = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription/contract`))
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        currency: 'INR',
        billingPeriod: 'monthly',
        items: [],
        source: 'plan',
        recurringTotalMinor: '99900',
        nextInvoiceOneTimeMinor: '0',
        planAmountMinor: '99900',
        appliesFromNextInvoice: false,
      })
    })

    it('PUT contract replaces unbilled items, keeps billed ones, audits the reason, and drives cardBilling.amountMinor', async () => {
      await setPrice(99900n)
      const billed = await prisma.billingLineItem.create({
        data: { tenantId, description: 'Install', quantity: 1, unitAmountMinor: 50000n, kind: 'one_time', sortOrder: 0, billedAt: new Date() },
      })
      await prisma.billingLineItem.create({ data: { tenantId, description: 'Old line', quantity: 1, unitAmountMinor: 1n, kind: 'recurring', sortOrder: 1 } })
      const url = `/ops/v1/tenants/${tenantId}/subscription/contract`
      const res = await authed(request(httpServer).put(url)).send({
        items: [
          { description: ' POS licence ', quantity: 3, unitAmountMinor: 20000, kind: 'recurring' },
          { description: 'Training', quantity: 1, unitAmountMinor: 15000, kind: 'one_time' },
        ],
        reason: 'Signed contract',
      })
      expect(res.status).toBe(200)
      const body = res.body as { items: Array<{ id: string; description: string; billedAt: string | null }>; source: string; recurringTotalMinor: string; nextInvoiceOneTimeMinor: string }
      expect(body).toMatchObject({ source: 'contract', recurringTotalMinor: '60000', nextInvoiceOneTimeMinor: '15000' })
      expect(body.items.map((i) => i.description)).toEqual(['POS licence', 'Training', 'Install'])
      expect(body.items[2]).toMatchObject({ id: billed.id })
      expect(body.items[2].billedAt).not.toBeNull()
      expect(await prisma.billingLineItem.count({ where: { tenantId } })).toBe(3)

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'billing.contract_updated' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ reason: 'Signed contract', actorId: operatorId })

      const sub = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}/subscription`))
      expect((sub.body as { cardBilling: { amountMinor: string } }).cardBilling.amountMinor).toBe('60000')

      const cleared = await authed(request(httpServer).put(url)).send({ items: [], reason: 'Back to plan' })
      expect(cleared.status).toBe(200)
      expect(cleared.body).toMatchObject({ source: 'plan', recurringTotalMinor: '99900' })
      expect(await prisma.billingLineItem.count({ where: { tenantId } })).toBe(1)
    })

    it('PUT contract rejects bad input with 400 and writes nothing', async () => {
      const url = `/ops/v1/tenants/${tenantId}/subscription/contract`
      const line = { description: 'POS licence', quantity: 1, unitAmountMinor: 100, kind: 'recurring' }
      for (const body of [
        { items: [line] },
        { items: [{ ...line, description: '  ' }], reason: 'x' },
        { items: [{ ...line, quantity: 0 }], reason: 'x' },
        { items: [{ ...line, unitAmountMinor: -5 }], reason: 'x' },
        { items: [{ ...line, unitAmountMinor: '100' }], reason: 'x' },
        { items: [{ ...line, kind: 'weekly' }], reason: 'x' },
        { items: Array.from({ length: 31 }, () => line), reason: 'x' },
        { items: 'nope', reason: 'x' },
      ]) {
        const res = await authed(request(httpServer).put(url)).send(body)
        expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400)
      }
      expect(await prisma.billingLineItem.count({ where: { tenantId } })).toBe(0)
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'billing.contract_updated' } })).toBe(0)
    })

    it('billing-link: 409 no_recurring_items for a contract with only one-time lines', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
      await prisma.billingLineItem.create({ data: { tenantId, description: 'Setup', quantity: 1, unitAmountMinor: 100n, kind: 'one_time', sortOrder: 0 } })
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/subscription/billing-link`)).send({})
      expect(res.status).toBe(409)
      expect(errorCodeOf(res)).toBe('no_recurring_items')
    })

    it('PATCH payments refuses wallets without Card (#284)', async () => {
      const res = await authed(request(httpServer).patch(`/ops/v1/tenants/${tenantId}/payments`)).send({ allowedMethods: ['apple_pay', 'google_pay'], reason: 'x' })
      expect(res.status).toBe(400)
      expect((res.body as { error: { code: string; message: string } }).error).toMatchObject({
        code: 'validation_failed',
        message: 'Apple Pay and Google Pay run on card payments, so Card must stay on',
      })
    })
  })
})
