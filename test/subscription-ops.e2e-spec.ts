// CAP-5 success criteria, end to end: suspend/reactivate round-trips without
// data loss; the grace window is read from config, not hardcoded; every
// mutation requires a reason.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
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
  await prisma.role.deleteMany()
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
})
