// CAP-6 success criteria, end to end: a device silent 48h raises an alert
// with zero customer involvement; the response never carries a payload body;
// devices sort severity-first (silent > lagging > healthy).
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { ALERT_CHANNEL, AlertChannel, SilentDeviceAlert } from '../src/ops'
import { signOpsToken, uuidv7 } from '../src/platform'

const EMAIL = 'sync-health-operator@restiq.example'
const HOUR = 60 * 60 * 1000

async function wipe(prisma: PrismaClient): Promise<void> {
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

describe('/ops/v1/sync-health and heartbeat (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let token: string
  let tenantId: string
  let outletId: string
  let notifySilentDevice: ReturnType<typeof vi.fn<(alert: SilentDeviceAlert) => Promise<void>>>

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: EMAIL } })
    const operator = await prisma.operatorUser.create({
      data: { email: EMAIL, passwordHash: await argon2.hash('irrelevant-here') },
    })
    token = signOpsToken({ id: operator.id, email: operator.email })

    notifySilentDevice = vi.fn<(alert: SilentDeviceAlert) => Promise<void>>(() => Promise.resolve())
    const spyChannel: AlertChannel = { notifySilentDevice }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ALERT_CHANNEL)
      .useValue(spyChannel)
      .compile()
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
    notifySilentDevice.mockClear()
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

  async function makeDevice(overrides?: { label?: string; lastContactAt?: Date | null }): Promise<string> {
    const id = uuidv7()
    await prisma.device.create({
      data: {
        id,
        tenantId,
        outletId,
        label: overrides?.label ?? 'Terminal 1',
        type: 'pos',
        hardwareKeyFingerprint: `fp-${id}`,
        enrolledAt: new Date(Date.now() - 100 * HOUR),
        lastContactAt: overrides?.lastContactAt,
      },
    })
    return id
  }

  describe('POST /ops/v1/devices/:id/heartbeat', () => {
    it('updates the telemetry snapshot and lastContactAt', async () => {
      const deviceId = await makeDevice({ lastContactAt: null })
      const res = await authed(request(httpServer).post(`/ops/v1/devices/${deviceId}/heartbeat`)).send({
        outboxDepth: 12,
        appVersion: '2.4.1',
        clockSkewSeconds: 3,
        recentRejectionCount: 0,
      })
      expect(res.status).toBe(200)

      const row = await prisma.device.findUnique({ where: { id: deviceId } })
      expect(row?.outboxDepth).toBe(12)
      expect(row?.appVersion).toBe('2.4.1')
      expect(row?.clockSkewSeconds).toBe(3)
      expect(row?.recentRejectionCount).toBe(0)
      expect(row?.lastContactAt).not.toBeNull()
      expect(row!.lastContactAt!.getTime()).toBeGreaterThan(Date.now() - 5000)
    })

    it('rejects an invalid payload', async () => {
      const deviceId = await makeDevice()
      const res = await authed(request(httpServer).post(`/ops/v1/devices/${deviceId}/heartbeat`)).send({
        outboxDepth: -1,
        appVersion: '2.4.1',
        clockSkewSeconds: 3,
        recentRejectionCount: 0,
      })
      expect(res.status).toBe(400)
    })

    it('404s for an unknown device', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/devices/${uuidv7()}/heartbeat`)).send({
        outboxDepth: 0,
        appVersion: '2.4.1',
        clockSkewSeconds: 0,
        recentRejectionCount: 0,
      })
      expect(res.status).toBe(404)
    })

    it('rejects without an ops token', async () => {
      const deviceId = await makeDevice()
      const res = await request(httpServer).post(`/ops/v1/devices/${deviceId}/heartbeat`).send({
        outboxDepth: 0,
        appVersion: '2.4.1',
        clockSkewSeconds: 0,
        recentRejectionCount: 0,
      })
      expect(res.status).toBe(401)
    })
  })

  describe('GET /ops/v1/sync-health', () => {
    it('classifies healthy, lagging and silent devices and sorts severity-first', async () => {
      const healthyId = await makeDevice({ label: 'Healthy', lastContactAt: new Date(Date.now() - 5 * 60 * 1000) })
      const laggingId = await makeDevice({ label: 'Lagging', lastContactAt: new Date(Date.now() - 2 * HOUR) })
      const silentId = await makeDevice({ label: 'Silent', lastContactAt: new Date(Date.now() - 50 * HOUR) })

      const res = await authed(request(httpServer).get('/ops/v1/sync-health'))
      expect(res.status).toBe(200)
      const body = res.body as {
        devices: Array<{ deviceId: string; severity: string; tenantName: string; outletName: string | null }>
        summary: { healthy: number; lagging: number; silent: number }
      }
      expect(body.summary).toEqual({ healthy: 1, lagging: 1, silent: 1 })
      expect(body.devices.map((d) => d.deviceId)).toEqual([silentId, laggingId, healthyId])
      expect(body.devices.find((d) => d.deviceId === silentId)?.severity).toBe('silent')
      expect(body.devices.find((d) => d.deviceId === laggingId)?.severity).toBe('lagging')
      expect(body.devices.find((d) => d.deviceId === healthyId)?.severity).toBe('healthy')
      expect(body.devices.find((d) => d.deviceId === healthyId)?.tenantName).toBe('Spice Route Hospitality')
      expect(body.devices.find((d) => d.deviceId === healthyId)?.outletName).toBe('Indiranagar')
    })

    it('treats a device that never heartbeated as silent once 48h past enrolment', async () => {
      const id = uuidv7()
      await prisma.device.create({
        data: {
          id,
          tenantId,
          outletId,
          label: 'Never checked in',
          type: 'pos',
          hardwareKeyFingerprint: `fp-${id}`,
          enrolledAt: new Date(Date.now() - 60 * HOUR),
        },
      })
      const res = await authed(request(httpServer).get('/ops/v1/sync-health'))
      const body = res.body as { devices: Array<{ deviceId: string; severity: string; lastContactAt: string | null }> }
      const row = body.devices.find((d) => d.deviceId === id)
      expect(row?.severity).toBe('silent')
      expect(row?.lastContactAt).toBeNull()
    })

    it('a 48h-silent device triggers the alert abstraction', async () => {
      const silentId = await makeDevice({ label: 'Silent', lastContactAt: new Date(Date.now() - 49 * HOUR) })
      await makeDevice({ label: 'Healthy', lastContactAt: new Date() })

      await authed(request(httpServer).get('/ops/v1/sync-health'))

      expect(notifySilentDevice).toHaveBeenCalledTimes(1)
      const alert = notifySilentDevice.mock.calls[0][0]
      expect(alert).toMatchObject({ deviceId: silentId, tenantId })
      expect(alert.lagSeconds).toBeGreaterThan(48 * 3600)
    })

    it('never carries a payload-body field anywhere in the response', async () => {
      await makeDevice({ lastContactAt: new Date() })
      const res = await authed(request(httpServer).get('/ops/v1/sync-health'))
      const raw = JSON.stringify(res.body)
      expect(raw.toLowerCase()).not.toContain('payload')
    })

    it('filters by tenantId and by severity', async () => {
      await makeDevice({ label: 'Healthy', lastContactAt: new Date() })
      const otherTenantId = uuidv7()
      await prisma.tenantRegistryEntry.create({ data: { tenantId: otherTenantId, region: 'in-mumbai', lifecycle: 'active' } })
      await prisma.tenant.create({
        data: {
          id: otherTenantId,
          name: 'Other Tenant',
          registeredAddress: 'x',
          contactName: 'x',
          contactEmail: 'other@test.example',
          contactPhone: 'x',
          country: 'IN',
          status: 'active',
          plan: 'standard',
          billingPeriod: 'monthly',
        },
      })
      const otherBrand = await prisma.brand.create({ data: { tenantId: otherTenantId, name: 'Other' } })
      const otherOutlet = await prisma.outlet.create({
        data: { tenantId: otherTenantId, brandId: otherBrand.id, name: 'Other Outlet', address: 'x', type: 'dine_in', timezone: 'Asia/Kolkata' },
      })
      await prisma.device.create({
        data: {
          id: uuidv7(),
          tenantId: otherTenantId,
          outletId: otherOutlet.id,
          label: 'Other silent',
          type: 'pos',
          hardwareKeyFingerprint: 'fp-other',
          enrolledAt: new Date(Date.now() - 100 * HOUR),
          lastContactAt: new Date(Date.now() - 60 * HOUR),
        },
      })

      const byTenant = (await authed(request(httpServer).get(`/ops/v1/sync-health?tenantId=${tenantId}`))).body as {
        devices: unknown[]
      }
      expect(byTenant.devices).toHaveLength(1)

      const bySeverity = (await authed(request(httpServer).get('/ops/v1/sync-health?severity=silent'))).body as {
        devices: Array<{ severity: string }>
        summary: { healthy: number; lagging: number; silent: number }
      }
      expect(bySeverity.devices.every((d) => d.severity === 'silent')).toBe(true)
      expect(bySeverity.devices).toHaveLength(1)
      // summary stays fleet-wide even though the row list is filtered
      expect(bySeverity.summary.healthy).toBe(1)
    })

    it('excludes revoked devices', async () => {
      const revokedId = await makeDevice({ label: 'Revoked', lastContactAt: new Date() })
      await prisma.device.update({ where: { id: revokedId }, data: { status: 'revoked', revokedAt: new Date() } })
      const res = await authed(request(httpServer).get('/ops/v1/sync-health'))
      const body = res.body as { devices: Array<{ deviceId: string }> }
      expect(body.devices.find((d) => d.deviceId === revokedId)).toBeUndefined()
    })

    it('rejects without an ops token', async () => {
      expect((await request(httpServer).get('/ops/v1/sync-health')).status).toBe(401)
    })
  })
})
