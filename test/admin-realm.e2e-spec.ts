// AD-10 success criterion, end to end: an ops-realm JWT presented to any
// /admin route is rejected, and vice versa, whichever secret signed it - the
// same disjoint-realm proof AD-3's ops-realm spec already established.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, uuidv7 } from '../src/platform'

async function wipe(prisma: PrismaClient): Promise<void> {
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
  await prisma.order.deleteMany()
  await prisma.clockEvent.deleteMany()
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

function adminSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET
  if (!secret) throw new Error('ADMIN_JWT_SECRET missing in e2e env')
  return secret
}

function opsSecret(): string {
  const secret = process.env.OPS_JWT_SECRET
  if (!secret) throw new Error('OPS_JWT_SECRET missing in e2e env')
  return secret
}

describe('/admin realm separation (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let tenantId: string
  let ownerToken: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Realm Test Co',
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
    ownerToken = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@test.example' })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('returns the checklist for a valid admin session', async () => {
    const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${ownerToken}`)
    expect(res.status).toBe(200)
    expect((res.body as { tenantStatus: string }).tenantStatus).toBe('provisioning')
  })

  it('rejects /admin without a token', async () => {
    const res = await request(httpServer).get('/admin/v1/checklist')
    expect(res.status).toBe(401)
    expect((res.body as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('rejects an ops-audience token on /admin, even signed with the admin secret', async () => {
    const token = jwt.sign({ email: 'operator@test.example' }, adminSecret(), {
      subject: 'ops-user-1',
      audience: 'ops',
      expiresIn: '1h',
    })
    const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real ops session token on /admin', async () => {
    const opsToken = signOpsToken({ id: uuidv7(), email: 'operator@test.example' })
    const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${opsToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects an admin-audience token on /ops, even signed with the ops secret', async () => {
    const token = jwt.sign({ email: 'owner@test.example', tenantId }, opsSecret(), {
      subject: uuidv7(),
      audience: 'admin',
      expiresIn: '1h',
    })
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real admin session token on /ops', async () => {
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${ownerToken}`)
    expect(res.status).toBe(401)
  })

  it('leaves non-admin routes (health) untouched by the admin guard', async () => {
    const res = await request(httpServer).get('/health')
    expect(res.status).toBe(200)
  })
})
