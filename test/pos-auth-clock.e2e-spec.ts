// CAP-1 success criteria, end to end:
//  - a correct PIN logs in and, for a single-outlet tenant, issues a pos
//    session token in one call
//  - a tenant with more than one outlet gets an outlet picker instead
//  - 5 wrong attempts locks THAT PIN for 30s (scoped per (tenant, pin), not
//    per tenant - a different, correct PIN still works)
//  - a successful login records a clock-in, and only once per local day
//  - clock-out ends the day's open clock-in
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface AuthenticatedBody {
  status: 'authenticated'
  token: string
  staff: { id: string; name: string }
  outlet: { id: string; name: string }
}
interface SelectOutletBody {
  status: 'select_outlet'
  pendingToken: string
  staff: { id: string; name: string }
  outlets: { id: string; name: string }[]
}

// Full table list (not just this file's own tables): the e2e suite shares
// one database and file execution order is not guaranteed, so every wipe()
// must be safe regardless of what another file left behind (same rationale
// as admin-realm.e2e-spec.ts's wipe()).
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

async function createTenant(prisma: PrismaClient, name = 'POS Test Co'): Promise<string> {
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
  return tenantId
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name: string): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: `${name} Brand` } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createStaffWithPin(prisma: PrismaClient, tenantId: string, name: string, pin: string): Promise<string> {
  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId, name: 'Cashier' } },
    create: { tenantId, name: 'Cashier', isSystem: true },
    update: {},
  })
  const staff = await prisma.staffUser.create({
    data: { tenantId, roleId: role.id, name, pinHash: await argon2.hash(pin), pinIssuedAt: new Date() },
  })
  return staff.id
}

describe('/pos/v1/auth and /pos/v1/clock (e2e)', () => {
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

  describe('single-outlet tenant', () => {
    it('logs in directly with the correct PIN, issuing a pos-realm token and recording a clock-in', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId, 'Only Outlet')
      const staffId = await createStaffWithPin(prisma, tenantId, 'Priya Nair', '1234')

      const res = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '1234' })
      expect(res.status).toBe(200)
      const body = res.body as AuthenticatedBody
      expect(body.status).toBe('authenticated')
      expect(body.token.split('.')).toHaveLength(3)
      expect(body.staff).toEqual({ id: staffId, name: 'Priya Nair' })
      expect(body.outlet).toEqual({ id: outletId, name: 'Only Outlet' })

      const events = await prisma.clockEvent.findMany({ where: { staffId } })
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('clock_in')
      expect(events[0]?.outletId).toBe(outletId)
    })

    it('does not record a second clock-in for the same local day', async () => {
      const tenantId = await createTenant(prisma)
      await createOutlet(prisma, tenantId, 'Only Outlet')
      const staffId = await createStaffWithPin(prisma, tenantId, 'Priya Nair', '1234')

      await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '1234' })
      const second = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '1234' })
      expect(second.status).toBe(200)

      const events = await prisma.clockEvent.findMany({ where: { staffId } })
      expect(events).toHaveLength(1)
    })

    it('rejects a wrong PIN with a generic error', async () => {
      const tenantId = await createTenant(prisma)
      await createOutlet(prisma, tenantId, 'Only Outlet')
      await createStaffWithPin(prisma, tenantId, 'Priya Nair', '1234')

      const res = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '9999' })
      expect(res.status).toBe(401)
      expect((res.body as ErrorBody).error.code).toBe('invalid_pin')
    })

    it('rejects a revoked PIN the same way as a wrong one', async () => {
      const tenantId = await createTenant(prisma)
      await createOutlet(prisma, tenantId, 'Only Outlet')
      const staffId = await createStaffWithPin(prisma, tenantId, 'Priya Nair', '1234')
      await prisma.staffUser.update({ where: { id: staffId }, data: { pinRevokedAt: new Date() } })

      const res = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '1234' })
      expect(res.status).toBe(401)
      expect((res.body as ErrorBody).error.code).toBe('invalid_pin')
    })

    it('rejects a malformed PIN at the validation layer', async () => {
      const tenantId = await createTenant(prisma)
      const res = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '12' })
      expect(res.status).toBe(400)
    })
  })

  describe('multi-outlet tenant', () => {
    it('returns an outlet picker instead of a session token, then finalises on select-outlet', async () => {
      const tenantId = await createTenant(prisma)
      const outletA = await createOutlet(prisma, tenantId, 'Indiranagar')
      const outletB = await createOutlet(prisma, tenantId, 'Koramangala')
      const staffId = await createStaffWithPin(prisma, tenantId, 'Rahul Iyer', '5678')

      const loginRes = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '5678' })
      expect(loginRes.status).toBe(200)
      const loginBody = loginRes.body as SelectOutletBody
      expect(loginBody.status).toBe('select_outlet')
      expect(loginBody.staff).toEqual({ id: staffId, name: 'Rahul Iyer' })
      expect(loginBody.outlets.map((o) => o.id).sort()).toEqual([outletA, outletB].sort())

      // No clock-in yet - the session isn't real until an outlet is picked.
      expect(await prisma.clockEvent.count({ where: { staffId } })).toBe(0)

      const selectRes = await request(httpServer)
        .post('/pos/v1/auth/select-outlet')
        .send({ pendingToken: loginBody.pendingToken, outletId: outletA })
      expect(selectRes.status).toBe(200)
      const selectBody = selectRes.body as AuthenticatedBody
      expect(selectBody.status).toBe('authenticated')
      expect(selectBody.outlet).toEqual({ id: outletA, name: 'Indiranagar' })
      expect(selectBody.token.split('.')).toHaveLength(3)

      const events = await prisma.clockEvent.findMany({ where: { staffId } })
      expect(events).toHaveLength(1)
      expect(events[0]?.outletId).toBe(outletA)
    })

    it('rejects select-outlet naming an outlet from a different tenant', async () => {
      const tenantId = await createTenant(prisma, 'Tenant A')
      await createOutlet(prisma, tenantId, 'A1')
      await createOutlet(prisma, tenantId, 'A2')
      await createStaffWithPin(prisma, tenantId, 'Rahul Iyer', '5678')

      const otherTenantId = await createTenant(prisma, 'Tenant B')
      const foreignOutletId = await createOutlet(prisma, otherTenantId, 'B1')

      const loginRes = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '5678' })
      const loginBody = loginRes.body as SelectOutletBody

      const res = await request(httpServer)
        .post('/pos/v1/auth/select-outlet')
        .send({ pendingToken: loginBody.pendingToken, outletId: foreignOutletId })
      expect(res.status).toBe(400)
    })

    it('rejects a garbage pendingToken', async () => {
      const res = await request(httpServer)
        .post('/pos/v1/auth/select-outlet')
        .send({ pendingToken: 'not-a-real-token', outletId: uuidv7() })
      expect(res.status).toBe(401)
    })
  })

  describe('lockout', () => {
    it('locks a specific (tenant, pin) pair after 5 wrong attempts, without blocking a different correct PIN', async () => {
      const tenantId = await createTenant(prisma)
      await createOutlet(prisma, tenantId, 'Only Outlet')
      await createStaffWithPin(prisma, tenantId, 'Priya Nair', '1234')

      const guessedWrongPin = '0000'
      for (let i = 0; i < 5; i++) {
        const res = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: guessedWrongPin })
        expect(res.status).toBe(401)
      }

      const lockedRes = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: guessedWrongPin })
      expect(lockedRes.status).toBe(429)
      expect((lockedRes.body as ErrorBody).error.code).toBe('locked_out')

      // The real PIN, never guessed, is untouched by the lock on '0000'.
      const realPinRes = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '1234' })
      expect(realPinRes.status).toBe(200)
    })
  })

  describe('clock out', () => {
    it('ends the open clock-in, and a second clock-out is rejected as not-clocked-in', async () => {
      const tenantId = await createTenant(prisma)
      await createOutlet(prisma, tenantId, 'Only Outlet')
      await createStaffWithPin(prisma, tenantId, 'Priya Nair', '1234')

      const loginRes = await request(httpServer).post('/pos/v1/auth/login').send({ tenantId, pin: '1234' })
      const { token } = loginRes.body as AuthenticatedBody

      const clockOutRes = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${token}`)
      expect(clockOutRes.status).toBe(200)
      expect((clockOutRes.body as { type: string }).type).toBe('clock_out')

      const secondClockOutRes = await request(httpServer).post('/pos/v1/clock/out').set('Authorization', `Bearer ${token}`)
      expect(secondClockOutRes.status).toBe(409)
      expect((secondClockOutRes.body as ErrorBody).error.code).toBe('not_clocked_in')
    })
  })
})
