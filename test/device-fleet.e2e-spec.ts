// CAP-4 success criteria, end to end: an expired or reused code fails;
// revocation is immediate, audited, and never deletes; hub role is only ever
// assigned by an operator, and designating one displaces the prior hub.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signOpsToken, uuidv7 } from '../src/platform'

const EMAIL = 'fleet-operator@restiq.example'

interface DeviceView {
  id: string
  tenantId: string
  outletId: string | null
  label: string
  type: string
  role: string
  status: string
  enrolledAt: string
  revokedAt: string | null
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
  await prisma.billShare.deleteMany()
  await prisma.tender.deleteMany()
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

describe('/ops/v1/devices (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let token: string
  let operatorId: string
  let tenantId: string
  let outletId: string

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
    const outlet = await prisma.outlet.create({
      data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })
    outletId = outlet.id
  })

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  async function generateCode(overrides?: Partial<{ tenantId: string; outletId: string; deviceType: string }>) {
    const res = await authed(request(httpServer).post('/ops/v1/devices/enrolment-codes')).send({
      tenantId: overrides?.tenantId ?? tenantId,
      outletId: overrides?.outletId ?? outletId,
      deviceType: overrides?.deviceType ?? 'pos',
    })
    return res
  }

  async function enroll(code: string, overrides?: Partial<{ hardwareKeyFingerprint: string; label: string }>) {
    return authed(request(httpServer).post('/ops/v1/devices/enroll')).send({
      code,
      hardwareKeyFingerprint: overrides?.hardwareKeyFingerprint ?? 'stub-fingerprint-1',
      label: overrides?.label,
    })
  }

  function codeOf(res: request.Response): string {
    return (res.body as { code: string }).code
  }

  function deviceOf(res: request.Response): DeviceView {
    return (res.body as { device: DeviceView }).device
  }

  function errorCodeOf(res: request.Response): string {
    return (res.body as { error: { code: string } }).error.code
  }

  describe('POST /ops/v1/devices/enrolment-codes', () => {
    it('generates a one-time code with a 15-minute TTL, stored only as a hash', async () => {
      const res = await generateCode()
      expect(res.status).toBe(201)
      const body = res.body as { code: string; deviceType: string; expiresAt: string }
      expect(body.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/)
      expect(body.deviceType).toBe('pos')
      const ttlMs = Date.parse(body.expiresAt) - Date.now()
      expect(ttlMs).toBeGreaterThan(14 * 60 * 1000)
      expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000)

      const rows = await prisma.enrolmentCode.findMany({ where: { tenantId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.codeHash).not.toBe(body.code)
      expect(rows[0]?.codeHash).toBe(createHash('sha256').update(body.code.replace('-', '')).digest('hex'))

      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'device.enrolment_code_generated' } })).toBe(1)
    })

    it('404s for an unknown tenant or an outlet outside the tenant', async () => {
      expect((await generateCode({ tenantId: uuidv7() })).status).toBe(404)
      expect((await generateCode({ outletId: uuidv7() })).status).toBe(404)
    })

    it('rejects an unknown device type', async () => {
      expect((await generateCode({ deviceType: 'printer' })).status).toBe(400)
    })

    it('rejects without an ops token', async () => {
      const res = await request(httpServer)
        .post('/ops/v1/devices/enrolment-codes')
        .send({ tenantId, outletId, deviceType: 'pos' })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /ops/v1/devices/enroll', () => {
    it('consumes a valid code and enrols the device, audited', async () => {
      const code = codeOf(await generateCode())
      const res = await enroll(code, { label: 'Terminal 1' })
      expect(res.status).toBe(201)
      const body = deviceOf(res)
      expect(body).toMatchObject({ tenantId, outletId, type: 'pos', role: 'terminal', status: 'active', label: 'Terminal 1' })

      expect(await prisma.device.count({ where: { tenantId } })).toBe(1)
      expect((await prisma.enrolmentCode.findFirst({ where: { tenantId } }))?.usedAt).not.toBeNull()
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'device.enrolled' } })).toBe(1)
    })

    it('rejects an invalid code', async () => {
      const res = await enroll('ZZZ-ZZZ')
      expect(res.status).toBe(400)
      expect(errorCodeOf(res)).toBe('code_invalid')
    })

    it('rejects an expired code even though it was never used', async () => {
      const code = codeOf(await generateCode())
      await prisma.enrolmentCode.updateMany({ where: { tenantId }, data: { expiresAt: new Date(Date.now() - 1000) } })
      const res = await enroll(code)
      expect(res.status).toBe(400)
      expect(errorCodeOf(res)).toBe('code_expired')
      expect(await prisma.device.count({ where: { tenantId } })).toBe(0)
    })

    it('rejects a reused code on the second attempt', async () => {
      const code = codeOf(await generateCode())
      const first = await enroll(code, { hardwareKeyFingerprint: 'fp-1' })
      expect(first.status).toBe(201)
      const second = await enroll(code, { hardwareKeyFingerprint: 'fp-2' })
      expect(second.status).toBe(409)
      expect(errorCodeOf(second)).toBe('code_already_used')
      expect(await prisma.device.count({ where: { tenantId } })).toBe(1)
    })

    it('accepts the code typed without its dash', async () => {
      const code = codeOf(await generateCode())
      const res = await enroll(code.replace('-', '').toLowerCase())
      expect(res.status).toBe(201)
    })
  })

  describe('PUT /ops/v1/devices/:id/hub', () => {
    async function enrolledDevice(label: string): Promise<DeviceView> {
      const code = codeOf(await generateCode())
      const res = await enroll(code, { hardwareKeyFingerprint: `fp-${label}`, label })
      return deviceOf(res)
    }

    it('designates a hub, audited', async () => {
      const device = await enrolledDevice('Terminal 1')
      const res = await authed(request(httpServer).put(`/ops/v1/devices/${device.id}/hub`)).send({ reason: 'Primary till' })
      expect(res.status).toBe(200)
      const body = res.body as { device: DeviceView; displacedDeviceId: string | null }
      expect(body.device.role).toBe('hub')
      expect(body.displacedDeviceId).toBeNull()
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'device.hub_designated' } })).toBe(1)
    })

    it('displaces the prior hub in the same outlet', async () => {
      const first = await enrolledDevice('Terminal 1')
      const second = await enrolledDevice('Terminal 2')
      await authed(request(httpServer).put(`/ops/v1/devices/${first.id}/hub`)).send({ reason: 'Initial hub' })

      const res = await authed(request(httpServer).put(`/ops/v1/devices/${second.id}/hub`)).send({ reason: 'Moved to counter 2' })
      expect(res.status).toBe(200)
      const body = res.body as { device: DeviceView; displacedDeviceId: string | null }
      expect(body.device.role).toBe('hub')
      expect(body.displacedDeviceId).toBe(first.id)

      expect((await prisma.device.findUnique({ where: { id: first.id } }))?.role).toBe('terminal')
      expect((await prisma.device.findUnique({ where: { id: second.id } }))?.role).toBe('hub')
    })

    it('rejects hub designation without a reason', async () => {
      const device = await enrolledDevice('Terminal 1')
      const res = await authed(request(httpServer).put(`/ops/v1/devices/${device.id}/hub`)).send({})
      expect(res.status).toBe(400)
    })

    it('404s for an unknown device', async () => {
      const res = await authed(request(httpServer).put(`/ops/v1/devices/${uuidv7()}/hub`)).send({ reason: 'x' })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /ops/v1/devices/:id/revoke', () => {
    async function enrolledDevice(): Promise<DeviceView> {
      const code = codeOf(await generateCode())
      const res = await enroll(code)
      return deviceOf(res)
    }

    it('revokes immediately, audited, and never deletes the row', async () => {
      const device = await enrolledDevice()
      const before = await prisma.device.count({ where: { tenantId } })

      const res = await authed(request(httpServer).post(`/ops/v1/devices/${device.id}/revoke`)).send({
        reason: 'Device reported stolen by outlet manager',
      })
      expect(res.status).toBe(200)
      const body = res.body as { device: DeviceView }
      expect(body.device.status).toBe('revoked')
      expect(body.device.revokedAt).not.toBeNull()

      // Never deleted - only status change + audit (SPEC success criterion).
      expect(await prisma.device.count({ where: { tenantId } })).toBe(before)
      const row = await prisma.device.findUnique({ where: { id: device.id } })
      expect(row?.status).toBe('revoked')
      expect(row?.label).toBe(device.label)

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'device.revoked' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ actorId: operatorId, actorEmail: EMAIL, reason: 'Device reported stolen by outlet manager' })
    })

    it('rejects revoking without a reason and writes nothing', async () => {
      const device = await enrolledDevice()
      const before = await prisma.auditEvent.count()
      const res = await authed(request(httpServer).post(`/ops/v1/devices/${device.id}/revoke`)).send({})
      expect(res.status).toBe(400)
      expect((await prisma.device.findUnique({ where: { id: device.id } }))?.status).toBe('active')
      expect(await prisma.auditEvent.count()).toBe(before)
    })

    it('revoking an already-revoked device conflicts, not a silent no-op', async () => {
      const device = await enrolledDevice()
      await authed(request(httpServer).post(`/ops/v1/devices/${device.id}/revoke`)).send({ reason: 'x' })
      const again = await authed(request(httpServer).post(`/ops/v1/devices/${device.id}/revoke`)).send({ reason: 'x' })
      expect(again.status).toBe(409)
    })

    it('the sync_dead_letters table is ready to receive routed ops for a revoked device (AD-7)', async () => {
      const device = await enrolledDevice()
      await authed(request(httpServer).post(`/ops/v1/devices/${device.id}/revoke`)).send({ reason: 'Device reported stolen' })

      const dlq = await prisma.syncDeadLetter.create({
        data: {
          tenantId,
          deviceId: device.id,
          opId: uuidv7(),
          reasonCode: 'device_revoked',
          reasonText: 'Device was revoked while an op was in flight',
          payloadMeta: { kind: 'order.sync' },
        },
      })
      expect(dlq.resolvedAt).toBeNull()
      expect(await prisma.syncDeadLetter.count({ where: { tenantId, deviceId: device.id } })).toBe(1)
    })

    it('rejects without an ops token', async () => {
      const device = await enrolledDevice()
      const res = await request(httpServer).post(`/ops/v1/devices/${device.id}/revoke`).send({ reason: 'x' })
      expect(res.status).toBe(401)
    })
  })

  describe('GET /ops/v1/devices', () => {
    it('lists the fleet across tenants with tenant and outlet names, newest-first', async () => {
      const code = codeOf(await generateCode())
      await enroll(code, { label: 'Terminal 1' })

      const res = await authed(request(httpServer).get('/ops/v1/devices'))
      expect(res.status).toBe(200)
      const body = res.body as { devices: Array<{ tenantName: string; outletName: string | null; label: string }>; total: number }
      expect(body.total).toBe(1)
      expect(body.devices[0]).toMatchObject({ tenantName: 'Spice Route Hospitality', outletName: 'Indiranagar', label: 'Terminal 1' })
    })

    it('filters by tenantId, type and status', async () => {
      const posCode = codeOf(await generateCode({ deviceType: 'pos' }))
      await enroll(posCode, { hardwareKeyFingerprint: 'fp-pos', label: 'POS 1' })
      const kdsCode = codeOf(await generateCode({ deviceType: 'kds' }))
      const kdsDevice = deviceOf(await enroll(kdsCode, { hardwareKeyFingerprint: 'fp-kds', label: 'KDS 1' }))
      await authed(request(httpServer).post(`/ops/v1/devices/${kdsDevice.id}/revoke`)).send({ reason: 'x' })

      const byTenant = (await authed(request(httpServer).get(`/ops/v1/devices?tenantId=${tenantId}`))).body as { total: number }
      expect(byTenant.total).toBe(2)

      const byType = (await authed(request(httpServer).get('/ops/v1/devices?type=kds'))).body as { total: number }
      expect(byType.total).toBe(1)

      const byStatus = (await authed(request(httpServer).get('/ops/v1/devices?status=revoked'))).body as { total: number }
      expect(byStatus.total).toBe(1)
    })

    it('rejects without an ops token', async () => {
      expect((await request(httpServer).get('/ops/v1/devices')).status).toBe(401)
    })
  })
})
