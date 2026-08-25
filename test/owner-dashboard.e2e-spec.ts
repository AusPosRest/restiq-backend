// tenant-admin/CAP-8 success criteria, end to end: an owner's dashboard
// reflects real counts (outlets, active devices per outlet, tenant-wide
// staff headcount, tenant-wide menu item count) rather than fabricated
// figures; sales/margin/labour/waste are honestly reported as hasData:false
// zeros (no Order/Bill/Payment model exists yet - RESTIQ's POS Core Loop
// hasn't been built), never silently faked or omitted; `asOf` is a real,
// current timestamp; and every figure is scoped to the caller's own tenant.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'

interface DashboardMetric {
  amountMinor: number
  currency: string
  hasData: boolean
  message: string
}
interface OutletDashboardView {
  outletId: string
  outletName: string
  deviceCount: number
  sales: DashboardMetric
  margin: DashboardMetric
  labourCost: DashboardMetric
  waste: DashboardMetric
}
interface DashboardBody {
  asOf: string
  tenant: {
    outletCount: number
    staffCount: number
    menuItemCount: number
    deviceCount: number
    status: string
    goLiveAt: string | null
  }
  outlets: OutletDashboardView[]
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

async function createOwner(
  prisma: PrismaClient,
  name = 'Spice Route Hospitality',
  status: 'provisioning' | 'active' = 'active',
): Promise<{ tenantId: string; token: string }> {
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
      status,
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  const token = signAdminToken({ id: uuidv7(), tenantId, email: `owner-${tenantId}@spiceroute.example` })
  return { tenantId, token }
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name: string): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: `${name} Brand` } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createDevice(
  prisma: PrismaClient,
  tenantId: string,
  outletId: string,
  status: 'active' | 'revoked' = 'active',
): Promise<void> {
  await prisma.device.create({
    data: {
      tenantId,
      outletId,
      label: `Device ${uuidv7()}`,
      type: 'pos',
      status,
      hardwareKeyFingerprint: `fp-${uuidv7()}`,
      enrolledAt: new Date(),
      revokedAt: status === 'revoked' ? new Date() : null,
    },
  })
}

async function createStaff(prisma: PrismaClient, tenantId: string, count: number): Promise<void> {
  const role = await prisma.role.create({ data: { tenantId, name: 'Waiter', isSystem: true } })
  for (let i = 0; i < count; i++) {
    await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: `Staff ${i}` } })
  }
}

async function createMenuItems(prisma: PrismaClient, tenantId: string, availableCount: number, unavailableCount: number): Promise<void> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  for (let i = 0; i < availableCount; i++) {
    await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Available ${i}`, shortName: `A${i}`, available: true } })
  }
  for (let i = 0; i < unavailableCount; i++) {
    await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Unavailable ${i}`, shortName: `U${i}`, available: false } })
  }
}

describe('/admin/v1/dashboard (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)

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

  it('reflects real outlet, device, staff, and menu item counts', async () => {
    const { tenantId, token } = await createOwner(prisma)
    const outletA = await createOutlet(prisma, tenantId, 'Indiranagar')
    const outletB = await createOutlet(prisma, tenantId, 'Koramangala')

    await createDevice(prisma, tenantId, outletA, 'active')
    await createDevice(prisma, tenantId, outletA, 'active')
    await createDevice(prisma, tenantId, outletA, 'revoked') // must not count
    await createDevice(prisma, tenantId, outletB, 'active')

    await createStaff(prisma, tenantId, 3)
    await createMenuItems(prisma, tenantId, 5, 2) // 5 available, 2 not (86'd)

    const res = await authed(request(httpServer).get('/admin/v1/dashboard'), token)
    expect(res.status).toBe(200)
    const body = res.body as DashboardBody

    expect(body.tenant.outletCount).toBe(2)
    expect(body.tenant.staffCount).toBe(3)
    expect(body.tenant.menuItemCount).toBe(5) // only available items count
    expect(body.tenant.deviceCount).toBe(3) // active devices only, across both outlets

    const byId = new Map(body.outlets.map((o) => [o.outletId, o]))
    expect(byId.get(outletA)?.deviceCount).toBe(2)
    expect(byId.get(outletB)?.deviceCount).toBe(1)
    expect(byId.get(outletA)?.outletName).toBe('Indiranagar')
    expect(byId.get(outletB)?.outletName).toBe('Koramangala')
  })

  it('honestly reports sales/margin/labour/waste as hasData:false zeros for every outlet, in the tenant currency', async () => {
    const { tenantId, token } = await createOwner(prisma)
    await createOutlet(prisma, tenantId, 'Whitefield')

    const res = await authed(request(httpServer).get('/admin/v1/dashboard'), token)
    const body = res.body as DashboardBody
    expect(body.outlets).toHaveLength(1)

    for (const metric of [body.outlets[0].sales, body.outlets[0].margin, body.outlets[0].labourCost, body.outlets[0].waste]) {
      expect(metric.hasData).toBe(false)
      expect(metric.amountMinor).toBe(0)
      expect(metric.currency).toBe('INR')
      expect(metric.message.length).toBeGreaterThan(0)
    }
  })

  it('returns an honest zero-state dashboard when the tenant has no outlets yet', async () => {
    const { token } = await createOwner(prisma)
    const res = await authed(request(httpServer).get('/admin/v1/dashboard'), token)
    expect(res.status).toBe(200)
    const body = res.body as DashboardBody
    expect(body.outlets).toEqual([])
    expect(body.tenant).toMatchObject({ outletCount: 0, staffCount: 0, menuItemCount: 0, deviceCount: 0 })
  })

  it('computes asOf as a real, current timestamp reflecting when the aggregate was computed', async () => {
    const { token } = await createOwner(prisma)
    const before = Date.now()
    const res = await authed(request(httpServer).get('/admin/v1/dashboard'), token)
    const after = Date.now()
    const body = res.body as DashboardBody

    const asOfMs = new Date(body.asOf).getTime()
    expect(asOfMs).toBeGreaterThanOrEqual(before)
    expect(asOfMs).toBeLessThanOrEqual(after)
  })

  it('reports tenant status and goLiveAt from the real go-live audit event, null before go-live', async () => {
    const { tenantId, token } = await createOwner(prisma, 'Not Live Yet', 'provisioning')

    const before = await authed(request(httpServer).get('/admin/v1/dashboard'), token)
    expect((before.body as DashboardBody).tenant.status).toBe('provisioning')
    expect((before.body as DashboardBody).tenant.goLiveAt).toBeNull()

    const wentLiveAt = new Date()
    await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'active' } })
    await prisma.auditEvent.create({
      data: { tenantId, actorEmail: 'owner@spiceroute.example', action: 'tenant.went_live', reason: 'Owner completed the go-live checklist', occurredAt: wentLiveAt },
    })

    const after = await authed(request(httpServer).get('/admin/v1/dashboard'), token)
    const afterBody = after.body as DashboardBody
    expect(afterBody.tenant.status).toBe('active')
    expect(afterBody.tenant.goLiveAt).toBe(wentLiveAt.toISOString())
  })

  it('never returns another tenant\'s outlets or counts (cross-tenant isolation)', async () => {
    const ownerA = await createOwner(prisma, 'Tenant A')
    const ownerB = await createOwner(prisma, 'Tenant B')

    const outletA = await createOutlet(prisma, ownerA.tenantId, 'A Outlet')
    await createOutlet(prisma, ownerB.tenantId, 'B Outlet')
    await createDevice(prisma, ownerA.tenantId, outletA, 'active')
    await createStaff(prisma, ownerB.tenantId, 4)
    await createMenuItems(prisma, ownerB.tenantId, 10, 0)

    const res = await authed(request(httpServer).get('/admin/v1/dashboard'), ownerA.token)
    const body = res.body as DashboardBody

    expect(body.outlets).toHaveLength(1)
    expect(body.outlets[0].outletName).toBe('A Outlet')
    expect(body.tenant.outletCount).toBe(1)
    expect(body.tenant.staffCount).toBe(0)
    expect(body.tenant.menuItemCount).toBe(0)
    expect(body.tenant.deviceCount).toBe(1)
  })

  it('rejects without an admin token', async () => {
    const res = await request(httpServer).get('/admin/v1/dashboard')
    expect(res.status).toBe(401)
  })
})
