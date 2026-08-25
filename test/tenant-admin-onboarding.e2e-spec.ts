// CAP-1 + CAP-2 success criteria, end to end: an invite accepts exactly once,
// expired vs. already-used tokens get distinct error codes, checklist state
// persists across separate requests, and go-live is blocked until every
// required step is complete.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { uuidv7 } from '../src/platform'

const CHECKLIST_STEPS = ['outlet_details', 'floor_plan', 'menu_import', 'devices', 'staff']
const STRONG_PASSWORD = 'a-strong-owner-password'

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
  await prisma.order.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
  await prisma.diningTable.deleteMany()
  await prisma.floor.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

function tokenHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

async function createTenant(prisma: PrismaClient): Promise<string> {
  const tenantId = uuidv7()
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
      status: 'provisioning',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  return tenantId
}

async function createInvite(
  prisma: PrismaClient,
  tenantId: string,
  overrides?: { expiresAt?: Date; email?: string },
): Promise<string> {
  const rawToken = `${uuidv7()}${uuidv7()}`
  await prisma.ownerInvite.create({
    data: {
      tenantId,
      email: overrides?.email ?? 'owner@spiceroute.example',
      firstName: 'Arjun',
      lastName: 'Mehta',
      tokenHash: tokenHash(rawToken),
      expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 3_600_000),
    },
  })
  return rawToken
}

describe('/admin/v1 owner invite + go-live checklist (e2e)', () => {
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

  async function acceptInvite(tenantId: string, token: string, password = STRONG_PASSWORD): Promise<request.Response> {
    return request(httpServer).post('/admin/v1/auth/accept-invite').send({ token, password })
  }

  async function acceptedOwnerToken(tenantId: string): Promise<string> {
    const rawToken = await createInvite(prisma, tenantId)
    const res = await acceptInvite(tenantId, rawToken)
    return (res.body as { token: string }).token
  }

  describe('POST /admin/v1/auth/accept-invite', () => {
    it('accepts a valid invite, creates the owner, seeds the checklist, and issues an admin session', async () => {
      const tenantId = await createTenant(prisma)
      const rawToken = await createInvite(prisma, tenantId)

      const res = await acceptInvite(tenantId, rawToken)
      expect(res.status).toBe(200)
      const body = res.body as { token: string; owner: { id: string; tenantId: string; email: string } }
      expect(body.owner.tenantId).toBe(tenantId)
      expect(body.owner.email).toBe('owner@spiceroute.example')
      expect(body.token.split('.')).toHaveLength(3)

      const owner = await prisma.ownerUser.findUnique({
        where: { tenantId_email: { tenantId, email: 'owner@spiceroute.example' } },
      })
      expect(owner).not.toBeNull()

      const invite = await prisma.ownerInvite.findFirst({ where: { tenantId } })
      expect(invite?.usedAt).not.toBeNull()

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'owner.invite_accepted' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.actorEmail).toBe('owner@spiceroute.example')

      const progress = await prisma.checklistProgress.findUnique({ where: { tenantId } })
      expect(progress).not.toBeNull()
    })

    it('rejects an unknown token distinctly', async () => {
      const tenantId = await createTenant(prisma)
      const res = await acceptInvite(tenantId, 'not-a-real-token')
      expect(res.status).toBe(400)
      expect((res.body as { error: { code: string } }).error.code).toBe('invite_invalid')
    })

    it('rejects an expired invite distinctly', async () => {
      const tenantId = await createTenant(prisma)
      const rawToken = await createInvite(prisma, tenantId, { expiresAt: new Date(Date.now() - 1000) })
      const res = await acceptInvite(tenantId, rawToken)
      expect(res.status).toBe(400)
      expect((res.body as { error: { code: string } }).error.code).toBe('invite_expired')
    })

    it('rejects an already-used invite distinctly, with a different code than expiry', async () => {
      const tenantId = await createTenant(prisma)
      const rawToken = await createInvite(prisma, tenantId)
      const first = await acceptInvite(tenantId, rawToken)
      expect(first.status).toBe(200)

      const second = await acceptInvite(tenantId, rawToken, 'a-different-password')
      expect(second.status).toBe(409)
      expect((second.body as { error: { code: string } }).error.code).toBe('invite_already_used')
    })

    it('rejects a password below the minimum length', async () => {
      const tenantId = await createTenant(prisma)
      const rawToken = await createInvite(prisma, tenantId)
      const res = await acceptInvite(tenantId, rawToken, 'short')
      expect(res.status).toBe(400)
      expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed')
    })
  })

  describe('GET /admin/v1/checklist, PATCH /admin/v1/checklist/:step, POST /admin/v1/checklist/go-live', () => {
    it('returns sensible defaults: every step incomplete, go-live not yet possible', async () => {
      const tenantId = await createTenant(prisma)
      const token = await acceptedOwnerToken(tenantId)

      const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      const body = res.body as { steps: Array<{ step: string; completed: boolean }>; canGoLive: boolean; tenantStatus: string }
      expect(body.steps.map((s) => s.step).sort()).toEqual([...CHECKLIST_STEPS].sort())
      expect(body.steps.every((s) => !s.completed)).toBe(true)
      expect(body.canGoLive).toBe(false)
      expect(body.tenantStatus).toBe('provisioning')
    })

    it('persists a step completion across separate requests', async () => {
      const tenantId = await createTenant(prisma)
      const token = await acceptedOwnerToken(tenantId)

      const patch = await request(httpServer)
        .patch('/admin/v1/checklist/outlet_details')
        .set('Authorization', `Bearer ${token}`)
        .send({ completed: true })
      expect(patch.status).toBe(200)

      const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${token}`)
      const step = (res.body as { steps: Array<{ step: string; completed: boolean; completedAt: string | null }> }).steps.find(
        (s) => s.step === 'outlet_details',
      )
      expect(step?.completed).toBe(true)
      expect(step?.completedAt).toBeTruthy()
    })

    it('un-completes a step when patched with completed: false', async () => {
      const tenantId = await createTenant(prisma)
      const token = await acceptedOwnerToken(tenantId)
      await request(httpServer).patch('/admin/v1/checklist/devices').set('Authorization', `Bearer ${token}`).send({ completed: true })

      const res = await request(httpServer)
        .patch('/admin/v1/checklist/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ completed: false })
      const step = (res.body as { steps: Array<{ step: string; completed: boolean }> }).steps.find((s) => s.step === 'devices')
      expect(step?.completed).toBe(false)
    })

    it('rejects an unknown step name', async () => {
      const tenantId = await createTenant(prisma)
      const token = await acceptedOwnerToken(tenantId)
      const res = await request(httpServer)
        .patch('/admin/v1/checklist/not-a-step')
        .set('Authorization', `Bearer ${token}`)
        .send({ completed: true })
      expect(res.status).toBe(400)
      expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed')
    })

    it('blocks go-live listing the incomplete steps, then succeeds once every step is complete', async () => {
      const tenantId = await createTenant(prisma)
      const token = await acceptedOwnerToken(tenantId)

      const blocked = await request(httpServer).post('/admin/v1/checklist/go-live').set('Authorization', `Bearer ${token}`)
      expect(blocked.status).toBe(409)
      const blockedBody = blocked.body as { error: { code: string; missingSteps: string[] } }
      expect(blockedBody.error.code).toBe('checklist_incomplete')
      expect(blockedBody.error.missingSteps.sort()).toEqual([...CHECKLIST_STEPS].sort())

      for (const step of CHECKLIST_STEPS.slice(0, -1)) {
        await request(httpServer).patch(`/admin/v1/checklist/${step}`).set('Authorization', `Bearer ${token}`).send({ completed: true })
      }
      const stillBlocked = await request(httpServer).post('/admin/v1/checklist/go-live').set('Authorization', `Bearer ${token}`)
      expect(stillBlocked.status).toBe(409)
      expect((stillBlocked.body as { error: { missingSteps: string[] } }).error.missingSteps).toEqual([CHECKLIST_STEPS.at(-1)])

      await request(httpServer)
        .patch(`/admin/v1/checklist/${CHECKLIST_STEPS.at(-1)}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ completed: true })
      const live = await request(httpServer).post('/admin/v1/checklist/go-live').set('Authorization', `Bearer ${token}`)
      expect(live.status).toBe(201)
      expect((live.body as { tenant: { status: string } }).tenant.status).toBe('active')

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
      expect(tenant?.status).toBe('active')

      const auditRows = await prisma.auditEvent.findMany({ where: { tenantId, action: 'tenant.went_live' } })
      expect(auditRows).toHaveLength(1)

      // Idempotent re-call: still succeeds, no second audit row.
      const again = await request(httpServer).post('/admin/v1/checklist/go-live').set('Authorization', `Bearer ${token}`)
      expect(again.status).toBe(201)
      expect((again.body as { tenant: { status: string } }).tenant.status).toBe('active')
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'tenant.went_live' } })).toBe(1)
    })

    it('rejects checklist routes without an admin token', async () => {
      expect((await request(httpServer).get('/admin/v1/checklist')).status).toBe(401)
      expect((await request(httpServer).post('/admin/v1/checklist/go-live')).status).toBe(401)
    })
  })
})
