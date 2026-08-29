// CAP-2 success criteria, end to end: atomic provisioning with every seed,
// resumable drafts, and nothing created when the transaction fails.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signOpsToken } from '../src/platform'

const EMAIL = 'onboarder@restiq.example'

function submitPayload(overrides?: { registrationNumber?: string; companyName?: string }) {
  return {
    business: {
      companyName: overrides?.companyName ?? 'Spice Route Hospitality Pvt Ltd',
      registeredAddress: '12 MG Road, Bengaluru, Karnataka 560001',
      contactName: 'Arjun Mehta',
      contactEmail: 'arjun@spiceroute.example',
      contactPhone: '+91 98765 43210',
    },
    tax: {
      country: 'IN',
      registrationNumber: overrides?.registrationNumber ?? '29ABCDE1234F1Z5',
      legalEntityName: 'Spice Route Hospitality Pvt Ltd',
      taxProfile: 'India GST - CGST/SGST split',
      fssaiLicense: '10012031000123',
      compositionScheme: false,
    },
    brandsOutlets: {
      brandName: 'Spice Route',
      outlets: [
        { name: 'Indiranagar', address: '100 Feet Road, Indiranagar', type: 'dine_in', timezone: 'Asia/Kolkata' },
        { name: 'Koramangala', address: '5th Block, Koramangala', type: 'qsr', timezone: 'Asia/Kolkata' },
      ],
    },
    subscription: { plan: 'enterprise', billingPeriod: 'monthly' },
    ownerInvite: { email: 'owner@spiceroute.example', firstName: 'Arjun', lastName: 'Mehta' },
  }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.orderLine.deleteMany()
  // invoice/subscription (CAP-5) restrict-delete tenants; wiped first so this
  // helper is safe regardless of what another e2e file left behind (the test
  // suite shares one database and file execution order is not guaranteed).
  // shifts/cash_movements (pos/CAP-10) restrict-delete tenants/outlets/staff
  // the same way - wiped first for the same reason.
  await prisma.cashMovement.deleteMany()
  await prisma.shift.deleteMany()
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
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
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

describe('/ops/v1/tenants onboarding (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let token: string
  let operatorId: string

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

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  describe('drafts', () => {
    it('404s when no draft exists', async () => {
      const res = await authed(request(httpServer).get('/ops/v1/tenants/draft'))
      expect(res.status).toBe(404)
      expect((res.body as { error: { code: string } }).error.code).toBe('not_found')
    })

    it('saves steps independently and returns them on resume', async () => {
      const step1 = { companyName: 'Draft Co', contactEmail: 'x@y.example' }
      const step3 = { brandName: 'Drafty' }
      expect((await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/1')).send(step1)).status).toBe(200)
      expect((await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/3')).send(step3)).status).toBe(200)

      const res = await authed(request(httpServer).get('/ops/v1/tenants/draft'))
      expect(res.status).toBe(200)
      const draft = (res.body as { draft: { steps: Record<string, unknown>; updatedAt: string } }).draft
      expect(draft.steps['1']).toEqual(step1)
      expect(draft.steps['3']).toEqual(step3)
      expect(Date.parse(draft.updatedAt)).not.toBeNaN()
    })

    it('overwrites a step on re-save', async () => {
      await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/1')).send({ companyName: 'Renamed Co' })
      const res = await authed(request(httpServer).get('/ops/v1/tenants/draft'))
      expect((res.body as { draft: { steps: Record<string, unknown> } }).draft.steps['1']).toEqual({ companyName: 'Renamed Co' })
    })

    it('rejects an out-of-range step and non-object data', async () => {
      expect((await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/6')).send({})).status).toBe(400)
      expect((await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/0')).send({})).status).toBe(400)
      const res = await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/2')).send([1, 2])
      expect(res.status).toBe(400)
    })

    it('deletes the draft', async () => {
      expect((await authed(request(httpServer).delete('/ops/v1/tenants/draft'))).status).toBe(204)
      expect((await authed(request(httpServer).get('/ops/v1/tenants/draft'))).status).toBe(404)
    })

    it('rejects draft routes without an ops token', async () => {
      expect((await request(httpServer).get('/ops/v1/tenants/draft')).status).toBe(401)
    })
  })

  describe('atomic provisioning', () => {
    it('creates tenant, registry entry, tax, brand/outlets, six roles, sample menu, invite and audit row in one submit', async () => {
      const res = await authed(request(httpServer).post('/ops/v1/tenants')).send(submitPayload())
      expect(res.status).toBe(201)
      const body = res.body as {
        tenant: { id: string; name: string; status: string }
        invite: { email: string; expiresAt: string }
      }
      expect(body.tenant.status).toBe('provisioning')
      expect(body.invite.email).toBe('owner@spiceroute.example')
      expect(Date.parse(body.invite.expiresAt)).toBeGreaterThan(Date.now())

      const tenantId = body.tenant.id

      const registry = await prisma.tenantRegistryEntry.findUnique({ where: { tenantId } })
      expect(registry?.lifecycle).toBe('active')
      expect(registry?.region).toBe('in-mumbai')

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
      expect(tenant?.status).toBe('provisioning')
      expect(tenant?.country).toBe('IN')
      expect(tenant?.plan).toBe('enterprise')

      expect(await prisma.tenantTaxRegistration.count({ where: { tenantId } })).toBe(1)
      expect(await prisma.brand.count({ where: { tenantId } })).toBe(1)
      expect(await prisma.outlet.count({ where: { tenantId } })).toBe(2)

      const roles = await prisma.role.findMany({ where: { tenantId } })
      expect(roles.map((r) => r.name).sort()).toEqual(['Accountant', 'Cashier', 'Kitchen', 'Manager', 'Owner', 'Waiter'])
      expect(roles.every((r) => r.isSystem)).toBe(true)

      expect(await prisma.menuCategory.count({ where: { tenantId } })).toBeGreaterThan(0)
      const items = await prisma.menuItem.findMany({ where: { tenantId } })
      expect(items.length).toBeGreaterThan(0)
      expect(items.every((i) => i.shortName.length > 0)).toBe(true)
      const prices = await prisma.itemPrice.findMany({ where: { tenantId } })
      expect(prices).toHaveLength(items.length)
      expect(prices.every((p) => p.currency === 'INR')).toBe(true)

      const invites = await prisma.ownerInvite.findMany({ where: { tenantId } })
      expect(invites).toHaveLength(1)
      expect(invites[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/)

      // AD-6/AD-8: audited with actor + reason, region-side, same transaction.
      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'tenant.provisioned' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.actorId).toBe(operatorId)
      expect(audit[0]?.actorEmail).toBe(EMAIL)
      expect(audit[0]?.reason).toBeTruthy()
    })

    it('deletes the operator draft on successful submit', async () => {
      await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/1')).send({ companyName: 'Another Co' })
      const res = await authed(request(httpServer).post('/ops/v1/tenants')).send(
        submitPayload({ registrationNumber: '27ZYXWV9876K1Z8', companyName: 'Another Co' }),
      )
      expect(res.status).toBe(201)
      expect((await authed(request(httpServer).get('/ops/v1/tenants/draft'))).status).toBe(404)
    })

    it('rolls back EVERYTHING on a mid-transaction failure and keeps the draft', async () => {
      const before = {
        tenants: await prisma.tenant.count(),
        registry: await prisma.tenantRegistryEntry.count(),
        outlets: await prisma.outlet.count(),
        roles: await prisma.role.count(),
        invites: await prisma.ownerInvite.count(),
        audit: await prisma.auditEvent.count(),
      }
      await authed(request(httpServer).put('/ops/v1/tenants/draft/steps/1')).send({ companyName: 'Doomed Co' })

      // Same GSTIN as the first provisioned tenant: the unique constraint
      // fires mid-transaction, after tenant + registry rows were written.
      const res = await authed(request(httpServer).post('/ops/v1/tenants')).send(
        submitPayload({ companyName: 'Doomed Co' }),
      )
      expect(res.status).toBe(409)
      expect((res.body as { error: { code: string } }).error.code).toBe('conflict')

      expect(await prisma.tenant.count()).toBe(before.tenants)
      expect(await prisma.tenantRegistryEntry.count()).toBe(before.registry)
      expect(await prisma.outlet.count()).toBe(before.outlets)
      expect(await prisma.role.count()).toBe(before.roles)
      expect(await prisma.ownerInvite.count()).toBe(before.invites)
      expect(await prisma.auditEvent.count()).toBe(before.audit)
      expect(await prisma.tenant.findFirst({ where: { name: 'Doomed Co' } })).toBeNull()

      // The draft survives the failure - resumable, never lost.
      expect((await authed(request(httpServer).get('/ops/v1/tenants/draft'))).status).toBe(200)
      await authed(request(httpServer).delete('/ops/v1/tenants/draft'))
    })

    it('rejects a malformed GSTIN for India', async () => {
      const res = await authed(request(httpServer).post('/ops/v1/tenants')).send(
        submitPayload({ registrationNumber: 'NOT-A-GSTIN' }),
      )
      expect(res.status).toBe(400)
      expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed')
    })

    it('rejects a payload with a missing step section', async () => {
      const payload: Record<string, unknown> = { ...submitPayload() }
      delete payload.ownerInvite
      const res = await authed(request(httpServer).post('/ops/v1/tenants')).send(payload)
      expect(res.status).toBe(400)
    })
  })

  describe('GET /ops/v1/tenants', () => {
    it('lists provisioned tenants', async () => {
      const res = await authed(request(httpServer).get('/ops/v1/tenants'))
      expect(res.status).toBe(200)
      const tenants = (res.body as { tenants: Array<Record<string, unknown>> }).tenants
      expect(tenants.length).toBeGreaterThanOrEqual(2)
      const spiceRoute = tenants.find((t) => t.name === 'Spice Route Hospitality Pvt Ltd')
      expect(spiceRoute).toMatchObject({ status: 'provisioning', country: 'IN', outletCount: 2 })
    })
  })
})
