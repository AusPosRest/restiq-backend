// qr-self-order/CAP-1 success criteria, end to end (SPEC-qr-self-order, story
// 1):
//  - a session binds to exactly one table (a second start on the same table
//    409s)
//  - joining with the right PIN succeeds; a wrong PIN fails and the join
//    endpoint rate-limits repeated wrong guesses (~5/30s)
//  - an outlet with `qr_ordering` disabled (or no capability row at all)
//    refuses both the availability check and start/join server-side - never
//    just a client-side gate
//  - a staff close (pos realm) flips the session to closed and subsequent
//    guest calls fail gracefully (410), never a crash
//  - every guest read/write is scoped to the signed-in tenant (RLS, AD-5)
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface SessionView {
  sessionId: string
  status: 'open' | 'settled' | 'closed'
  table: { id: string; label: string }
  outletId: string
  guests: { id: string; name: string; joinedAt: string }[]
  createdAt: string
  expiresAt: string
  closedAt: string | null
}
interface StartResult {
  token: string
  pin: string
  session: SessionView
}
interface JoinResult {
  token: string
  session: SessionView
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
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

async function createTenant(prisma: PrismaClient, name = 'Guest Test Co'): Promise<string> {
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

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Koramangala'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Guest Test Brand' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createTable(prisma: PrismaClient, tenantId: string, outletId: string, label = 'T1'): Promise<string> {
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
  const table = await prisma.diningTable.create({
    data: { tenantId, floorId: floor.id, label, x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 },
  })
  return table.id
}

async function enableQrOrdering(prisma: PrismaClient, tenantId: string, outletId: string): Promise<void> {
  await prisma.outletCapability.upsert({
    where: { outletId_key: { outletId, key: 'qr_ordering' } },
    create: { tenantId, outletId, key: 'qr_ordering', enabled: true },
    update: { enabled: true },
  })
}

describe('/guest/v1 table sessions (e2e)', () => {
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

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses the availability check when qr_ordering has no capability row (absent = disabled)', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)

    const res = await request(httpServer).get(`/guest/v1/outlets/${outletId}/availability`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ available: false, reason: 'qr_ordering_disabled' })
  })

  it('refuses session start server-side when qr_ordering is disabled, even if the availability check is skipped', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    // Explicit disabled row (not just absent), proving the gate reads the
    // real enabled flag, not just row presence.
    await prisma.outletCapability.create({ data: { tenantId, outletId, key: 'qr_ordering', enabled: false } })

    const res = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    expect(res.status).toBe(403)
    expect((res.body as ErrorBody).error.code).toBe('qr_ordering_disabled')
  })

  it('starts a session, binds it to exactly one table, and a second start on the same table 409s', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    await enableQrOrdering(prisma, tenantId, outletId)

    const availabilityRes = await request(httpServer).get(`/guest/v1/outlets/${outletId}/availability`)
    expect(availabilityRes.body).toEqual({ available: true })

    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    expect(startRes.status).toBe(201)
    const started = startRes.body as StartResult
    expect(started.pin).toMatch(/^\d{4}$/)
    expect(started.session.status).toBe('open')
    expect(started.session.table.id).toBe(tableId)
    expect(started.session.guests).toEqual([expect.objectContaining({ name: 'Asha' })])
    expect(typeof started.token).toBe('string')

    const secondStartRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Rohan', phone: '+91 90000 22222' })
    expect(secondStartRes.status).toBe(409)
    expect((secondStartRes.body as ErrorBody).error.code).toBe('session_already_open')
  })

  it('joins with the right PIN and sees the earlier guest; a wrong PIN fails', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    await enableQrOrdering(prisma, tenantId, outletId)

    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    const { pin, session } = startRes.body as StartResult

    const wrongRes = await request(httpServer)
      .post('/guest/v1/sessions/join')
      .send({ outletId, tableId, pin: pin === '0000' ? '1111' : '0000', name: 'Rohan' })
    expect(wrongRes.status).toBe(403)
    expect((wrongRes.body as ErrorBody).error.code).toBe('invalid_pin')

    const joinRes = await request(httpServer).post('/guest/v1/sessions/join').send({ outletId, tableId, pin, name: 'Rohan' })
    expect(joinRes.status).toBe(200)
    const joined = joinRes.body as JoinResult
    expect(joined.session.sessionId).toBe(session.sessionId)
    expect(joined.session.guests.map((g) => g.name)).toEqual(['Asha', 'Rohan'])
    expect(typeof joined.token).toBe('string')
  })

  it('rate-limits repeated wrong PIN guesses against a table (~5/30s)', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    await enableQrOrdering(prisma, tenantId, outletId)

    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    const { pin } = startRes.body as StartResult
    const wrongPin = pin === '0000' ? '1111' : '0000'

    for (let i = 0; i < 5; i++) {
      const res = await request(httpServer).post('/guest/v1/sessions/join').send({ outletId, tableId, pin: wrongPin, name: 'Rohan' })
      expect(res.status).toBe(403)
    }

    // The 6th attempt - even with the CORRECT pin - is rate-limited, not
    // PIN-checked, proving the lock gates the endpoint, not just bad guesses.
    const lockedRes = await request(httpServer).post('/guest/v1/sessions/join').send({ outletId, tableId, pin, name: 'Rohan' })
    expect(lockedRes.status).toBe(429)
    expect((lockedRes.body as ErrorBody).error.code).toBe('locked_out')
  })

  it('reports "no such outlet or table" for an unknown outlet/table pair, never leaking tenant existence', async () => {
    const res = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId: uuidv7(), tableId: uuidv7(), name: 'Asha', phone: '+91 90000 11111' })
    expect(res.status).toBe(404)
    expect((res.body as ErrorBody).error.code).toBe('not_found')
  })

  it('GET /guest/v1/session returns the live view for an authenticated guest', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    await enableQrOrdering(prisma, tenantId, outletId)

    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    const { token, session } = startRes.body as StartResult

    const res = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect((res.body as SessionView).sessionId).toBe(session.sessionId)
    expect((res.body as SessionView).status).toBe('open')
  })

  it('GET /guest/v1/session without a token is rejected', async () => {
    const res = await request(httpServer).get('/guest/v1/session')
    expect(res.status).toBe(401)
  })

  it('staff close (pos realm) flips the session to closed and subsequent guest calls fail gracefully (410)', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    await enableQrOrdering(prisma, tenantId, outletId)

    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    const { token } = startRes.body as StartResult

    const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
    const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Server Priya' } })
    const posToken = signPosToken({ id: staff.id, tenantId, outletId, name: staff.name })

    const closeRes = await request(httpServer).post(`/pos/v1/tables/${tableId}/close-session`).set('Authorization', `Bearer ${posToken}`)
    expect(closeRes.status).toBe(200)
    expect(closeRes.body).toEqual({ closed: true })

    const afterClose = await prisma.tableSession.findFirst({ where: { tenantId, tableId } })
    expect(afterClose?.status).toBe('closed')
    expect(afterClose?.closedAt).not.toBeNull()

    // The guest's own token still verifies (it's a valid JWT) but the
    // session it points at is gone - a clean 410, never a crash or a 200
    // showing stale state.
    const staleRes = await request(httpServer).get('/guest/v1/session').set('Authorization', `Bearer ${token}`)
    expect(staleRes.status).toBe(410)
    expect((staleRes.body as ErrorBody).error.code).toBe('session_closed')

    // A second close attempt (nothing open left) reports cleanly, not a crash.
    const secondCloseRes = await request(httpServer).post(`/pos/v1/tables/${tableId}/close-session`).set('Authorization', `Bearer ${posToken}`)
    expect(secondCloseRes.status).toBe(404)
    expect((secondCloseRes.body as ErrorBody).error.code).toBe('no_open_session')

    // The table is free again - a brand new session can start on it.
    const restartRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'New Guest', phone: '+91 90000 33333' })
    expect(restartRes.status).toBe(201)
  })
})

// RLS isolation for table_sessions/guests (AD-5, NFR-8) is proven under a
// genuinely restricted, non-superuser connection in test/rls.e2e-spec.ts -
// the local/CI Postgres role behind TEST_DATABASE_URL is a superuser and
// bypasses RLS entirely, so asserting "zero rows under the wrong tenant"
// against that connection would pass for the wrong reason (no filtering
// happened at all). See rls.e2e-spec.ts's PROBE_ROLE fixture.
