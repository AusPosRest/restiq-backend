// AD-13 success criterion, end to end: a pos-realm JWT presented to any
// /admin or /ops route is rejected, and vice versa, whichever secret signed
// it - the same disjoint-realm proof AD-3/AD-10's realm specs already
// established, extended to the fourth realm. Also proves the intermediate
// `pos-pending` outlet-selection token (a different audience, same secret)
// can never satisfy the real pos guard.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, signPosToken, uuidv7 } from '../src/platform'

// Full table list (not just this file's own tables): the e2e suite shares
// one database and file execution order is not guaranteed, so every wipe()
// must be safe regardless of what another file left behind (same rationale
// as admin-realm.e2e-spec.ts's wipe()).
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

function posSecret(): string {
  const secret = process.env.POS_JWT_SECRET
  if (!secret) throw new Error('POS_JWT_SECRET missing in e2e env')
  return secret
}

function adminSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET
  if (!secret) throw new Error('ADMIN_JWT_SECRET missing in e2e env')
  return secret
}

describe('/pos realm separation (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let tenantId: string
  let staffId: string
  let outletId: string
  let posToken: string

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
        status: 'active',
        plan: 'standard',
        billingPeriod: 'monthly',
      },
    })
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Realm Test Brand' } })
    const outlet = await prisma.outlet.create({
      data: { tenantId, brandId: brand.id, name: 'Main', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })
    outletId = outlet.id
    const role = await prisma.role.create({ data: { tenantId, name: 'Cashier', isSystem: true } })
    const staff = await prisma.staffUser.create({
      data: { tenantId, roleId: role.id, name: 'Realm Staff', pinHash: await argon2.hash('4242'), pinIssuedAt: new Date() },
    })
    staffId = staff.id
    // Already clocked in today so a /pos/v1/clock/out call below can prove
    // the guard accepted the token (200), not just "didn't 401".
    await prisma.clockEvent.create({ data: { tenantId, staffId, outletId, type: 'clock_in', occurredAt: new Date() } })

    posToken = signPosToken({ id: staffId, tenantId, outletId, name: 'Realm Staff' })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('accepts a valid pos session on a /pos route', async () => {
    const res = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${posToken}`)
    expect(res.status).toBe(200)
  })

  it('rejects /pos without a token', async () => {
    const res = await request(httpServer).post('/pos/v1/clock/out')
    expect(res.status).toBe(401)
    expect((res.body as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('rejects an admin-audience token on /pos, even signed with the pos secret', async () => {
    const token = jwt.sign({ email: 'owner@test.example', tenantId }, posSecret(), {
      subject: uuidv7(),
      audience: 'admin',
      expiresIn: '1h',
    })
    const res = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real admin session token on /pos', async () => {
    const adminToken = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@test.example' })
    const res = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real ops session token on /pos', async () => {
    const opsToken = signOpsToken({ id: uuidv7(), email: 'operator@test.example' })
    const res = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${opsToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a pos-pending (outlet-selection) token on a real /pos route - a different audience, not a session', async () => {
    const pendingToken = jwt.sign({ tenantId }, posSecret(), { subject: staffId, audience: 'pos-pending', expiresIn: '5m' })
    const res = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${pendingToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a pos-audience token on /admin, even signed with the admin secret', async () => {
    const token = jwt.sign({ tenantId, outletId }, adminSecret(), { subject: staffId, audience: 'pos', expiresIn: '1h' })
    const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real pos session token on /admin', async () => {
    const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${posToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real pos session token on /ops', async () => {
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${posToken}`)
    expect(res.status).toBe(401)
  })

  it('leaves non-pos routes (health) untouched by the pos guard', async () => {
    const res = await request(httpServer).get('/health')
    expect(res.status).toBe(200)
  })
})
