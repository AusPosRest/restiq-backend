// CAP-3 success criteria, end to end: a filterable, cursor-paginated tenant
// list, the detail aggregate, and mutations that always land in audit_events
// with actor + reason - a missing reason is rejected before anything writes.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signOpsToken, uuidv7 } from '../src/platform'

const EMAIL = 'director@restiq.example'

interface ListBody {
  tenants: Array<{
    id: string
    name: string
    country: string
    status: string
    plan: string
    outletCount: number
    health: string
    createdAt: string
  }>
  nextCursor: string | null
  total: number
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // invoice/subscription (CAP-5) restrict-delete tenants; wiped first so this
  // helper is safe regardless of what another e2e file left behind (the test
  // suite shares one database and file execution order is not guaranteed).
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
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
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

describe('/ops/v1/tenants directory (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let token: string
  let operatorId: string

  const ids = { alpha: uuidv7(), bravo: uuidv7(), charlie: uuidv7() }
  const INVITE_TOKEN_HASH = createHash('sha256').update('original-token').digest('hex')

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: EMAIL } })
    const operator = await prisma.operatorUser.create({
      data: { email: EMAIL, passwordHash: await argon2.hash('irrelevant-here') },
    })
    operatorId = operator.id
    token = signOpsToken({ id: operator.id, email: operator.email })

    const base = {
      registeredAddress: '1 Test Street',
      contactName: 'Test Contact',
      contactEmail: 'contact@test.example',
      contactPhone: '+91 90000 00000',
    }
    const day = 86_400_000
    const now = Date.now()

    for (const [id, name, country, status, plan, createdAt] of [
      [ids.alpha, 'Alpha Cafe', 'IN', 'active', 'standard', new Date(now - 3 * day)],
      [ids.bravo, 'Bravo Bistro', 'AU', 'active', 'enterprise', new Date(now - 2 * day)],
      [ids.charlie, 'Charlie Chaat', 'IN', 'provisioning', 'standard', new Date(now - day)],
    ] as const) {
      await prisma.tenantRegistryEntry.create({ data: { tenantId: id, region: 'in-mumbai', lifecycle: 'active' } })
      await prisma.tenant.create({
        data: { id, name, country, status, plan, billingPeriod: 'monthly', createdAt, ...base },
      })
    }

    const brand = await prisma.brand.create({ data: { tenantId: ids.alpha, name: 'Alpha Brand' } })
    await prisma.outlet.create({
      data: { tenantId: ids.alpha, brandId: brand.id, name: 'Alpha One', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })
    const bravoBrand = await prisma.brand.create({ data: { tenantId: ids.bravo, name: 'Bravo Brand' } })
    for (const name of ['Bravo One', 'Bravo Two']) {
      await prisma.outlet.create({
        data: { tenantId: ids.bravo, brandId: bravoBrand.id, name, address: 'B', type: 'qsr', timezone: 'Australia/Sydney' },
      })
    }
    await prisma.tenantTaxRegistration.create({
      data: {
        tenantId: ids.alpha,
        registrationType: 'gstin',
        registrationNumber: '29AAAAA0000A1Z5',
        legalEntityName: 'Alpha Cafe Pvt Ltd',
        taxProfile: 'India GST',
      },
    })
    await prisma.role.createMany({
      data: ['Owner', 'Manager'].map((name) => ({ tenantId: ids.alpha, name, isSystem: true })),
    })
    await prisma.ownerInvite.create({
      data: {
        tenantId: ids.alpha,
        email: 'owner@alpha.example',
        firstName: 'Ada',
        lastName: 'Alpha',
        tokenHash: INVITE_TOKEN_HASH,
        expiresAt: new Date(now + day),
      },
    })
    await prisma.tenantCapability.create({ data: { tenantId: ids.alpha, key: 'reservations', enabled: true } })

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

  describe('GET /ops/v1/tenants', () => {
    it('lists tenants newest-first with outlet counts and stub health', async () => {
      const res = await authed(request(httpServer).get('/ops/v1/tenants'))
      expect(res.status).toBe(200)
      const body = res.body as ListBody
      expect(body.total).toBe(3)
      expect(body.nextCursor).toBeNull()
      expect(body.tenants.map((t) => t.name)).toEqual(['Charlie Chaat', 'Bravo Bistro', 'Alpha Cafe'])
      const bravo = body.tenants.find((t) => t.id === ids.bravo)
      expect(bravo).toMatchObject({ country: 'AU', status: 'active', plan: 'enterprise', outletCount: 2, health: 'unknown' })
      expect(Date.parse(body.tenants[0].createdAt)).not.toBeNaN()
    })

    it('filters by status, country, plan and name search', async () => {
      const byStatus = (await authed(request(httpServer).get('/ops/v1/tenants?status=provisioning'))).body as ListBody
      expect(byStatus.tenants.map((t) => t.id)).toEqual([ids.charlie])
      expect(byStatus.total).toBe(1)

      const byCountry = (await authed(request(httpServer).get('/ops/v1/tenants?country=AU'))).body as ListBody
      expect(byCountry.tenants.map((t) => t.id)).toEqual([ids.bravo])

      const byPlan = (await authed(request(httpServer).get('/ops/v1/tenants?plan=enterprise'))).body as ListBody
      expect(byPlan.tenants.map((t) => t.id)).toEqual([ids.bravo])

      const byQuery = (await authed(request(httpServer).get('/ops/v1/tenants?q=chA'))).body as ListBody
      expect(byQuery.tenants.map((t) => t.id)).toEqual([ids.charlie])
    })

    it('treats every tenant as health unknown until telemetry exists', async () => {
      const unknown = (await authed(request(httpServer).get('/ops/v1/tenants?health=unknown'))).body as ListBody
      expect(unknown.total).toBe(3)
      const silent = (await authed(request(httpServer).get('/ops/v1/tenants?health=silent'))).body as ListBody
      expect(silent.tenants).toEqual([])
      expect(silent.total).toBe(0)
    })

    it('paginates with a cursor and no overlap', async () => {
      const first = (await authed(request(httpServer).get('/ops/v1/tenants?limit=2'))).body as ListBody
      expect(first.tenants).toHaveLength(2)
      expect(first.nextCursor).toBeTypeOf('string')
      const second = (
        await authed(request(httpServer).get(`/ops/v1/tenants?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`))
      ).body as ListBody
      expect(second.tenants).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      const seen = [...first.tenants, ...second.tenants].map((t) => t.id)
      expect(new Set(seen).size).toBe(3)
    })

    it('sorts by name when asked', async () => {
      const res = (await authed(request(httpServer).get('/ops/v1/tenants?sort=name&order=asc'))).body as ListBody
      expect(res.tenants.map((t) => t.name)).toEqual(['Alpha Cafe', 'Bravo Bistro', 'Charlie Chaat'])
    })

    it('rejects unknown filter values', async () => {
      expect((await authed(request(httpServer).get('/ops/v1/tenants?status=zombie'))).status).toBe(400)
      expect((await authed(request(httpServer).get('/ops/v1/tenants?sort=mrr'))).status).toBe(400)
      expect((await authed(request(httpServer).get('/ops/v1/tenants?limit=nope'))).status).toBe(400)
    })
  })

  describe('GET /ops/v1/tenants/:id', () => {
    it('returns the full detail aggregate', async () => {
      const res = await authed(request(httpServer).get(`/ops/v1/tenants/${ids.alpha}`))
      expect(res.status).toBe(200)
      const body = res.body as {
        tenant: Record<string, unknown>
        taxRegistrations: Array<Record<string, unknown>>
        brands: Array<Record<string, unknown>>
        outlets: Array<Record<string, unknown>>
        rolesCount: number
        ownerInvite: Record<string, unknown> | null
        capabilities: Array<{ key: string; enabled: boolean }>
      }
      expect(body.tenant).toMatchObject({
        id: ids.alpha,
        name: 'Alpha Cafe',
        country: 'IN',
        status: 'active',
        plan: 'standard',
        region: 'in-mumbai',
        brandingTokens: {},
      })
      expect(body.taxRegistrations).toHaveLength(1)
      expect(body.taxRegistrations[0]).toMatchObject({ registrationType: 'gstin', registrationNumber: '29AAAAA0000A1Z5' })
      expect(body.brands.map((b) => b.name)).toEqual(['Alpha Brand'])
      expect(body.outlets).toHaveLength(1)
      expect(body.outlets[0]).toMatchObject({ name: 'Alpha One', brandName: 'Alpha Brand', type: 'dine_in' })
      expect(body.rolesCount).toBe(2)
      expect(body.ownerInvite).toMatchObject({ email: 'owner@alpha.example', status: 'pending' })
      // Every known capability key appears; the stored override wins.
      const byKey = new Map(body.capabilities.map((c) => [c.key, c.enabled]))
      expect(byKey.get('reservations')).toBe(true)
      expect(byKey.get('tables_floor_plan')).toBe(true)
      expect(byKey.get('self_order_qr')).toBe(false)
      expect(byKey.size).toBeGreaterThanOrEqual(6)
    })

    it('404s for an unknown tenant', async () => {
      expect((await authed(request(httpServer).get(`/ops/v1/tenants/${uuidv7()}`))).status).toBe(404)
    })
  })

  describe('mutations (AD-6: audited with actor + reason, same transaction)', () => {
    it('updates tenant basics and writes the audit row', async () => {
      const res = await authed(request(httpServer).patch(`/ops/v1/tenants/${ids.alpha}`)).send({
        contactPhone: '+91 91111 11111',
        reason: 'Owner reported a new phone number',
      })
      expect(res.status).toBe(200)
      expect((await prisma.tenant.findUnique({ where: { id: ids.alpha } }))?.contactPhone).toBe('+91 91111 11111')
      const audit = await prisma.auditEvent.findMany({ where: { tenantId: ids.alpha, action: 'tenant.updated' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ actorId: operatorId, actorEmail: EMAIL, reason: 'Owner reported a new phone number' })
    })

    it('rejects a basics update without a reason and writes nothing', async () => {
      const before = await prisma.auditEvent.count()
      const res = await authed(request(httpServer).patch(`/ops/v1/tenants/${ids.alpha}`)).send({ name: 'Sneaky Rename' })
      expect(res.status).toBe(400)
      expect((await prisma.tenant.findUnique({ where: { id: ids.alpha } }))?.name).toBe('Alpha Cafe')
      expect(await prisma.auditEvent.count()).toBe(before)
    })

    it('rejects a basics update with no fields to change', async () => {
      expect(
        (await authed(request(httpServer).patch(`/ops/v1/tenants/${ids.alpha}`)).send({ reason: 'Nothing' })).status,
      ).toBe(400)
    })

    it('toggles a capability, audited with the key', async () => {
      const res = await authed(request(httpServer).put(`/ops/v1/tenants/${ids.alpha}/capabilities/self_order_qr`)).send({
        enabled: true,
        reason: 'Tenant requested QR ordering pilot',
      })
      expect(res.status).toBe(200)
      const row = await prisma.tenantCapability.findUnique({
        where: { tenantId_key: { tenantId: ids.alpha, key: 'self_order_qr' } },
      })
      expect(row?.enabled).toBe(true)
      const audit = await prisma.auditEvent.findMany({
        where: { tenantId: ids.alpha, action: 'tenant.capability.self_order_qr.enabled' },
      })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.reason).toBe('Tenant requested QR ordering pilot')

      // Toggling back off updates the same row and audits again.
      const off = await authed(request(httpServer).put(`/ops/v1/tenants/${ids.alpha}/capabilities/self_order_qr`)).send({
        enabled: false,
        reason: 'Pilot ended',
      })
      expect(off.status).toBe(200)
      expect(
        (await prisma.tenantCapability.findUnique({ where: { tenantId_key: { tenantId: ids.alpha, key: 'self_order_qr' } } }))
          ?.enabled,
      ).toBe(false)
      expect(
        await prisma.auditEvent.count({ where: { tenantId: ids.alpha, action: 'tenant.capability.self_order_qr.disabled' } }),
      ).toBe(1)
    })

    it('rejects a capability toggle without a reason or with an unknown key', async () => {
      expect(
        (await authed(request(httpServer).put(`/ops/v1/tenants/${ids.alpha}/capabilities/self_order_qr`)).send({ enabled: true }))
          .status,
      ).toBe(400)
      expect(
        (
          await authed(request(httpServer).put(`/ops/v1/tenants/${ids.alpha}/capabilities/time_travel`)).send({
            enabled: true,
            reason: 'x',
          })
        ).status,
      ).toBe(400)
    })

    it('updates branding tokens, audited', async () => {
      const tokens = { logo_url: 'https://cdn.example/alpha.png', accent: '#F59E0B' }
      const res = await authed(request(httpServer).put(`/ops/v1/tenants/${ids.alpha}/branding`)).send({
        tokens,
        reason: 'Applied the tenant brand kit',
      })
      expect(res.status).toBe(200)
      expect((await prisma.tenant.findUnique({ where: { id: ids.alpha } }))?.brandingTokens).toEqual(tokens)
      expect(await prisma.auditEvent.count({ where: { tenantId: ids.alpha, action: 'tenant.branding_updated' } })).toBe(1)
    })

    it('rejects branding without a reason or with non-string token values', async () => {
      expect(
        (await authed(request(httpServer).put(`/ops/v1/tenants/${ids.alpha}/branding`)).send({ tokens: { a: 'b' } })).status,
      ).toBe(400)
      expect(
        (
          await authed(request(httpServer).put(`/ops/v1/tenants/${ids.alpha}/branding`)).send({
            tokens: { nested: { a: 1 } },
            reason: 'x',
          })
        ).status,
      ).toBe(400)
    })

    it('regenerates the owner invite, invalidating the old token', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${ids.alpha}/owner-invite/regenerate`)).send({
        reason: 'Original invite email bounced',
      })
      expect(res.status).toBe(200)
      const body = res.body as { invite: { email: string; expiresAt: string; status: string } }
      expect(body.invite.email).toBe('owner@alpha.example')
      expect(body.invite.status).toBe('pending')
      expect(Date.parse(body.invite.expiresAt)).toBeGreaterThan(Date.now())

      const invites = await prisma.ownerInvite.findMany({ where: { tenantId: ids.alpha } })
      expect(invites).toHaveLength(1)
      expect(invites[0]?.tokenHash).not.toBe(INVITE_TOKEN_HASH)
      expect(await prisma.auditEvent.count({ where: { tenantId: ids.alpha, action: 'tenant.owner_invite_regenerated' } })).toBe(1)
    })

    it('404s regenerating when the tenant has no invite', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${ids.bravo}/owner-invite/regenerate`)).send({
        reason: 'x',
      })
      expect(res.status).toBe(404)
    })

    it('activates a provisioning tenant once, audited; a second activate conflicts', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${ids.charlie}/activate`)).send({
        reason: 'Owner completed onboarding checks',
      })
      expect(res.status).toBe(200)
      expect((await prisma.tenant.findUnique({ where: { id: ids.charlie } }))?.status).toBe('active')
      const audit = await prisma.auditEvent.findMany({ where: { tenantId: ids.charlie, action: 'tenant.activated' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.actorEmail).toBe(EMAIL)

      const again = await authed(request(httpServer).post(`/ops/v1/tenants/${ids.charlie}/activate`)).send({ reason: 'x' })
      expect(again.status).toBe(409)
    })

    it('rejects mutations without an ops token', async () => {
      expect((await request(httpServer).patch(`/ops/v1/tenants/${ids.alpha}`).send({ reason: 'x' })).status).toBe(401)
    })
  })

  describe('GET /ops/v1/dashboard/kpis/:key', () => {
    it('serves the fleet KPI counts, with placeholders for unbuilt telemetry', async () => {
      const activeTenants = await authed(request(httpServer).get('/ops/v1/dashboard/kpis/active_tenants'))
      expect(activeTenants.status).toBe(200)
      // alpha + bravo active from setup, charlie activated above.
      expect((activeTenants.body as { value: number }).value).toBe(3)

      const outlets = await authed(request(httpServer).get('/ops/v1/dashboard/kpis/outlets'))
      expect((outlets.body as { value: number }).value).toBe(3)

      expect(((await authed(request(httpServer).get('/ops/v1/dashboard/kpis/devices_online'))).body as { value: number }).value).toBe(0)
      expect(((await authed(request(httpServer).get('/ops/v1/dashboard/kpis/open_dlq'))).body as { value: number }).value).toBe(0)
    })

    it('rejects an unknown KPI key', async () => {
      expect((await authed(request(httpServer).get('/ops/v1/dashboard/kpis/mrr'))).status).toBe(400)
    })
  })
})
