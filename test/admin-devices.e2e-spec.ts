// tenant-admin/CAP-6 success criteria, end to end: an owner can list devices
// and generate enrolment codes for their own outlet only, and the exact same
// mechanism Platform Console's device fleet uses (AD-12 - one enrolment
// implementation, two callers); an owner from one tenant can never see or
// enrol a device for another tenant's outlet, even under the shared service;
// the go-live checklist's 'devices' step flips on the first device enrolled
// for the tenant; a printer's render-mode is readable and patchable, scoped
// to the outlet (story 5's printers table, not duplicated).
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, uuidv7 } from '../src/platform'

const OPERATOR_EMAIL = 'fleet-operator-cap6@restiq.example'

interface DeviceView {
  id: string
  tenantId: string
  outletId: string | null
  label: string
  type: string
  role: string
  status: string
}
interface DeviceListBody {
  devices: DeviceView[]
  nextCursor: string | null
  total: number
}
interface PrinterBody {
  id: string
  outletId: string
  name: string
  renderMode: string
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.orderLine.deleteMany()
  // shifts/cash_movements (pos/CAP-10) restrict-delete tenants/outlets/staff;
  // wiped first for the same reason invoice/subscription is below.
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

async function createOwner(prisma: PrismaClient, name = 'Spice Route Hospitality'): Promise<{ tenantId: string; token: string }> {
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
  const token = signAdminToken({ id: uuidv7(), tenantId, email: `owner-${tenantId}@spiceroute.example` })
  return { tenantId, token }
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

describe('/admin/v1/outlets/:outletId/devices (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let opsToken: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: OPERATOR_EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })

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

  function authed(req: request.Test, token: string): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  function devicesBase(outletId: string): string {
    return `/admin/v1/outlets/${outletId}/devices`
  }

  function floorPlanBase(outletId: string): string {
    return `/admin/v1/outlets/${outletId}/floor-plan`
  }

  async function enrolViaOps(code: string, hardwareKeyFingerprint: string): Promise<DeviceView> {
    const res = await authed(request(httpServer).post('/ops/v1/devices/enroll'), opsToken).send({ code, hardwareKeyFingerprint })
    expect(res.status).toBe(201)
    return (res.body as { device: DeviceView }).device
  }

  describe('GET /admin/v1/outlets/:outletId/devices', () => {
    it('lists devices scoped to the outlet (empty initially)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const res = await authed(request(httpServer).get(devicesBase(outletId)), token)
      expect(res.status).toBe(200)
      expect(res.body as DeviceListBody).toMatchObject({ devices: [], total: 0 })
    })

    it('returns devices enrolled for that outlet', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const codeRes = await authed(request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`), token).send({ deviceType: 'pos' })
      const code = (codeRes.body as { code: string }).code
      const device = await enrolViaOps(code, 'fp-1')

      const res = await authed(request(httpServer).get(devicesBase(outletId)), token);
      const body = res.body as DeviceListBody
      expect(body.total).toBe(1)
      expect(body.devices[0]).toMatchObject({ id: device.id, tenantId, outletId, type: 'pos' })
    })

    it('404s for an outlet belonging to another tenant (cross-tenant isolation)', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      const outletBId = await createOutlet(prisma, ownerB.tenantId)

      const res = await authed(request(httpServer).get(devicesBase(outletBId)), ownerA.token)
      expect(res.status).toBe(404)
    })

    it('rejects without an admin token', async () => {
      const { tenantId } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await request(httpServer).get(devicesBase(outletId))
      expect(res.status).toBe(401)
    })
  })

  describe('POST /admin/v1/outlets/:outletId/devices/enrolment-codes', () => {
    it('generates a one-time code via the same mechanism as Platform Console (15-minute TTL, sha256 hash, never the raw code stored)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const res = await authed(request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`), token).send({ deviceType: 'pos' })
      expect(res.status).toBe(201)
      const body = res.body as { code: string; deviceType: string; expiresAt: string }
      expect(body.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/)
      expect(body.deviceType).toBe('pos')

      const ttlMs = Date.parse(body.expiresAt) - Date.now()
      expect(ttlMs).toBeGreaterThan(14 * 60 * 1000)
      expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000)

      const rows = await prisma.enrolmentCode.findMany({ where: { tenantId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.outletId).toBe(outletId)
      expect(rows[0]?.codeHash).not.toBe(body.code)
      expect(rows[0]?.codeHash).toBe(createHash('sha256').update(body.code.replace('-', '')).digest('hex'))

      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'device.enrolment_code_generated' } })).toBe(1)
    })

    it('forces tenantId/outletId from the session, not the request body - an owner cannot generate a code for another tenant (cross-tenant isolation)', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      const outletBId = await createOutlet(prisma, ownerB.tenantId)

      // ownerA targets tenant B's outlet by URL; the body cannot smuggle a
      // different tenantId because AdminGenerateCodeDto has no such field.
      const res = await authed(request(httpServer).post(`${devicesBase(outletBId)}/enrolment-codes`), ownerA.token).send({
        deviceType: 'pos',
        tenantId: ownerB.tenantId,
      })
      expect(res.status).toBe(404)
      expect(await prisma.enrolmentCode.count({ where: { tenantId: ownerB.tenantId } })).toBe(0)
    })

    it('rejects an unknown device type', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await authed(request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`), token).send({ deviceType: 'printer' })
      expect(res.status).toBe(400)
    })

    it('rejects without an admin token', async () => {
      const { tenantId } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`).send({ deviceType: 'pos' })
      expect(res.status).toBe(401)
    })

    it('rejects an ops-realm token on the admin route (AD-3/AD-10 disjoint auth realms)', async () => {
      const { tenantId } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await authed(request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`), opsToken).send({ deviceType: 'pos' })
      expect(res.status).toBe(401)
    })
  })

  describe('go-live checklist integration', () => {
    it('flips the devices checklist step on the first device enrolled for the tenant', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      expect((await prisma.checklistProgress.findUnique({ where: { tenantId } }))?.devicesAt ?? null).toBeNull()

      const codeRes = await authed(request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`), token).send({ deviceType: 'pos' })
      // Generating a code alone must not flip it - only an actual enrolment.
      expect((await prisma.checklistProgress.findUnique({ where: { tenantId } }))?.devicesAt ?? null).toBeNull()

      await enrolViaOps((codeRes.body as { code: string }).code, 'fp-1')

      const after = await prisma.checklistProgress.findUnique({ where: { tenantId } })
      expect(after?.devicesAt).not.toBeNull()
    })

    it('does not re-fire on a second device (already flipped stays flipped)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const firstCode = (await authed(request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`), token).send({ deviceType: 'pos' })).body as { code: string }
      await enrolViaOps(firstCode.code, 'fp-1')
      const firstFlipAt = (await prisma.checklistProgress.findUnique({ where: { tenantId } }))?.devicesAt

      const secondCode = (await authed(request(httpServer).post(`${devicesBase(outletId)}/enrolment-codes`), token).send({ deviceType: 'kds' })).body as { code: string }
      await enrolViaOps(secondCode.code, 'fp-2')

      expect((await prisma.checklistProgress.findUnique({ where: { tenantId } }))?.devicesAt).toEqual(firstFlipAt)
    })
  })

  describe('printer render-mode (story 5\'s printers table, GET/PATCH)', () => {
    it('lists and patches a printer\'s render mode, scoped to the outlet', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const printer = (await authed(request(httpServer).post(`${floorPlanBase(outletId)}/printers`), token).send({ name: 'Kitchen Main', renderMode: 'text' })).body as PrinterBody

      const listRes = await authed(request(httpServer).get(`${floorPlanBase(outletId)}/printers`), token)
      expect(listRes.status).toBe(200)
      expect(listRes.body as PrinterBody[]).toEqual([printer])

      const patchRes = await authed(request(httpServer).patch(`${floorPlanBase(outletId)}/printers/${printer.id}`), token).send({ renderMode: 'bitmap' })
      expect(patchRes.status).toBe(200)
      expect((patchRes.body as PrinterBody).renderMode).toBe('bitmap')

      expect((await prisma.printer.findUnique({ where: { id: printer.id } }))?.renderMode).toBe('bitmap')
    })

    it('404s patching a printer belonging to another tenant', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      const outletBId = await createOutlet(prisma, ownerB.tenantId)
      const printer = (await authed(request(httpServer).post(`${floorPlanBase(outletBId)}/printers`), ownerB.token).send({ name: 'Kitchen Main', renderMode: 'text' })).body as PrinterBody

      const res = await authed(request(httpServer).patch(`${floorPlanBase(outletBId)}/printers/${printer.id}`), ownerA.token).send({ renderMode: 'bitmap' })
      expect(res.status).toBe(404)
    })
  })
})
