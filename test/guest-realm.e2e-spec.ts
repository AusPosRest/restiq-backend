// AD-17 success criterion, end to end: a guest-realm JWT presented to any
// /pos, /admin, or /ops route is rejected, and vice versa, whichever secret
// signed it - the same disjoint-realm proof AD-3/AD-10/AD-13's realm specs
// already established (see pos-realm.e2e-spec.ts), extended to the fifth
// realm and the first whose principal is not staff.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signGuestToken, signOpsToken, signPosToken, uuidv7 } from '../src/platform'

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.orderLine.deleteMany()
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
  await prisma.guest.deleteMany()
  await prisma.tableSession.deleteMany()
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

function guestSecret(): string {
  const secret = process.env.GUEST_JWT_SECRET
  if (!secret) throw new Error('GUEST_JWT_SECRET missing in e2e env')
  return secret
}

function adminSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET
  if (!secret) throw new Error('ADMIN_JWT_SECRET missing in e2e env')
  return secret
}

describe('/guest realm separation (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let tenantId: string
  let outletId: string
  let tableId: string
  let sessionId: string
  let guestId: string
  let guestToken: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)

    tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Guest Realm Test Co',
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
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Guest Realm Test Brand' } })
    const outlet = await prisma.outlet.create({
      data: { tenantId, brandId: brand.id, name: 'Main', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })
    outletId = outlet.id
    const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
    const table = await prisma.diningTable.create({
      data: { tenantId, floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 },
    })
    tableId = table.id
    const session = await prisma.tableSession.create({
      data: {
        tenantId,
        outletId,
        tableId,
        sessionPin: '1234',
        startedByGuestName: 'Realm Guest',
        startedByGuestPhone: '+91 90000 00000',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    sessionId = session.id
    const guest = await prisma.guest.create({ data: { tenantId, sessionId, name: 'Realm Guest', phone: '+91 90000 00000' } })
    guestId = guest.id

    guestToken = signGuestToken({ id: guestId, sessionId, tenantId, outletId, tableId, name: 'Realm Guest' })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('accepts a valid guest session on a /guest route', async () => {
    const res = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${guestToken}`)
    expect(res.status).toBe(200)
  })

  it('rejects /guest without a token', async () => {
    const res = await request(httpServer).get('/guest/v1/session')
    expect(res.status).toBe(401)
    expect((res.body as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('rejects an admin-audience token on /guest, even signed with the guest secret', async () => {
    const token = jwt.sign({ email: 'owner@test.example', tenantId }, guestSecret(), {
      subject: uuidv7(),
      audience: 'admin',
      expiresIn: '1h',
    })
    const res = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real admin session token on /guest', async () => {
    const adminToken = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@test.example' })
    const res = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real ops session token on /guest', async () => {
    const opsToken = signOpsToken({ id: uuidv7(), email: 'operator@test.example' })
    const res = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${opsToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real pos session token on /guest', async () => {
    const posToken = signPosToken({ id: uuidv7(), tenantId, outletId, name: 'Realm Staff' })
    const res = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${posToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a guest-audience token on /admin, even signed with the admin secret', async () => {
    const token = jwt.sign({ tenantId, outletId, tableId, sessionId, name: 'Realm Guest' }, adminSecret(), {
      subject: guestId,
      audience: 'guest',
      expiresIn: '1h',
    })
    const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real guest session token on /admin', async () => {
    const res = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${guestToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real guest session token on /ops', async () => {
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${guestToken}`)
    expect(res.status).toBe(401)
  })

  it('rejects a real guest session token on /pos', async () => {
    const res = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${guestToken}`)
    expect(res.status).toBe(401)
  })

  it("rejects a pos session token on /guest's own routes", async () => {
    const posToken = signPosToken({ id: uuidv7(), tenantId, outletId, name: 'Realm Staff' })
    const res = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${posToken}`)
    expect(res.status).toBe(401)
  })

  it('leaves non-guest routes (health) untouched by the guest guard', async () => {
    const res = await request(httpServer).get('/health')
    expect(res.status).toBe(200)
  })

  it('leaves public /guest routes reachable without any token (start/join/availability)', async () => {
    const res = await request(httpServer).get(`/guest/v1/outlets/${outletId}/availability`)
    expect(res.status).toBe(200)
  })
})
