// restiq-backend#171 regression: sign-in throttling is shared (a table, not
// process memory), counted before the secret is checked, keyed by source not
// by guessed PIN, and only trusts a device id or client IP that is genuinely
// trustworthy.
import { INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { ManagerAuthService, uuidv7 } from '../src/platform'

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
  await prisma.comboSlotOption.deleteMany()
  await prisma.comboSlot.deleteMany()
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

type Server = Parameters<typeof request>[0]

async function bootApp(trustProxyHops = 0): Promise<{ app: INestApplication; server: Server }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>()
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops)
  await app.init()
  return { app, server: app.getHttpServer() as Server }
}

describe('shared sign-in throttling (#171, e2e)', () => {
  let prisma: PrismaClient
  let a: { app: INestApplication; server: Server }
  let b: { app: INestApplication; server: Server }
  let proxied: { app: INestApplication; server: Server }

  async function seedTenant(): Promise<{ tenantId: string; outletId: string }> {
    const tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Throttle Co',
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
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Throttle Brand' } })
    const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Main', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
    return { tenantId, outletId: outlet.id }
  }

  async function staff(tenantId: string, pin: string, roleName = 'Cashier'): Promise<string> {
    const role = await prisma.role.upsert({
      where: { tenantId_name: { tenantId, name: roleName } },
      create: { tenantId, name: roleName, isSystem: true, isManager: roleName === 'Manager' },
      update: {},
    })
    const row = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: `Staff ${pin}`, pinHash: await argon2.hash(pin), pinIssuedAt: new Date() } })
    return row.id
  }

  async function device(tenantId: string, outletId: string, status: 'active' | 'revoked' = 'active'): Promise<string> {
    const row = await prisma.device.create({
      data: { id: uuidv7(), tenantId, outletId, label: `pos-${uuidv7().slice(-6)}`, type: 'pos', status, hardwareKeyFingerprint: `fp-${uuidv7()}`, enrolledAt: new Date(), revokedAt: status === 'revoked' ? new Date() : null },
      select: { id: true },
    })
    return row.id
  }

  const pinLogin = (server: Server, body: Record<string, string>, forwardedFor?: string) => {
    const req = request(server).post('/pos/v1/auth/login')
    if (forwardedFor) req.set('X-Forwarded-For', forwardedFor)
    return req.send(body)
  }

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    a = await bootApp()
    b = await bootApp()
    proxied = await bootApp(1)
  })

  afterAll(async () => {
    await Promise.all([a.app.close(), b.app.close(), proxied.app.close()])
    await prisma.$disconnect()
  })

  it('a burst of concurrent wrong PINs gets at most the limit checked; the rest are refused', async () => {
    const { tenantId } = await seedTenant()
    await staff(tenantId, '1234')
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => pinLogin(a.server, { tenantId, pin: String(5000 + i) })))
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(15)
  })

  it('two API instances share one count, and a restart does not reset it', async () => {
    const { tenantId } = await seedTenant()
    await staff(tenantId, '1234')
    for (let i = 0; i < 10; i++) {
      const server = i % 2 === 0 ? a.server : b.server
      expect((await pinLogin(server, { tenantId, pin: String(6000 + i) })).status).toBe(401)
    }
    expect((await pinLogin(b.server, { tenantId, pin: '1234' })).status).toBe(429)

    const restarted = await bootApp()
    try {
      expect((await pinLogin(restarted.server, { tenantId, pin: '1234' })).status).toBe(429)
    } finally {
      await restarted.app.close()
    }
  })

  it('an enrolled device keeps its own allowance, so a locked-out address does not lock the tills out', async () => {
    const { tenantId, outletId } = await seedTenant()
    await staff(tenantId, '1234')
    const till = await device(tenantId, outletId)
    for (let i = 0; i < 10; i++) await pinLogin(a.server, { tenantId, pin: String(7000 + i) })
    expect((await pinLogin(a.server, { tenantId, pin: '1234' })).status).toBe(429)
    expect((await pinLogin(a.server, { tenantId, pin: '1234', deviceId: till })).status).toBe(200)
  })

  it('an unknown or revoked device id is not trusted - it gets the address limit', async () => {
    const { tenantId, outletId } = await seedTenant()
    await staff(tenantId, '1234')
    const revoked = await device(tenantId, outletId, 'revoked')
    for (let i = 0; i < 10; i++) {
      await pinLogin(a.server, { tenantId, pin: String(7100 + i), deviceId: i % 2 === 0 ? uuidv7() : revoked })
    }
    expect((await pinLogin(a.server, { tenantId, pin: '1234', deviceId: revoked })).status).toBe(429)
    expect((await pinLogin(a.server, { tenantId, pin: '1234', deviceId: uuidv7() })).status).toBe(429)
  })

  it("another tenant's device id is not trusted either", async () => {
    const mine = await seedTenant()
    const other = await seedTenant()
    await staff(mine.tenantId, '1234')
    const foreignTill = await device(other.tenantId, other.outletId)
    for (let i = 0; i < 10; i++) await pinLogin(a.server, { tenantId: mine.tenantId, pin: String(7200 + i), deviceId: foreignTill })
    expect((await pinLogin(a.server, { tenantId: mine.tenantId, pin: '1234', deviceId: foreignTill })).status).toBe(429)
  })

  it('a busy shared till: six staff each mistype once and sign in; only the typos count against the till', async () => {
    const { tenantId, outletId } = await seedTenant()
    const till = await device(tenantId, outletId)
    const pins = ['1111', '2222', '3333', '4444', '5555', '6666']
    for (const pin of pins) await staff(tenantId, pin)
    for (const pin of pins) {
      expect((await pinLogin(a.server, { tenantId, pin: '9999', deviceId: till })).status).toBe(401)
      expect((await pinLogin(a.server, { tenantId, pin, deviceId: till })).status).toBe(200)
    }
    const [row] = await prisma.$queryRaw<{ attempts: number }[]>`SELECT attempts FROM auth_attempts WHERE key = ${`pos-pin:device:${tenantId}:${till}`}`
    expect(row.attempts).toBe(6)
    // A successful sign-in does not wipe earlier failures - otherwise someone
    // holding one PIN could keep guessing everyone else's (a manager's) forever.
  })

  it('X-Forwarded-For is ignored unless a proxy hop is trusted - rotating it does not reset the limit', async () => {
    const { tenantId } = await seedTenant()
    await staff(tenantId, '1234')
    for (let i = 0; i < 10; i++) await pinLogin(a.server, { tenantId, pin: String(7300 + i) }, `203.0.113.${i}`)
    expect((await pinLogin(a.server, { tenantId, pin: '1234' }, '198.51.100.7')).status).toBe(429)
  })

  it('behind a trusted proxy each client address has its own limit, and all unbound browsers share an hourly tenant cap', async () => {
    const { tenantId, outletId } = await seedTenant()
    await staff(tenantId, '1234')
    const till = await device(tenantId, outletId)
    for (let i = 0; i < 10; i++) await pinLogin(proxied.server, { tenantId, pin: String(7400 + i) }, '203.0.113.1')
    expect((await pinLogin(proxied.server, { tenantId, pin: '1234' }, '203.0.113.1')).status).toBe(429)
    expect((await pinLogin(proxied.server, { tenantId, pin: '1234' }, '203.0.113.2')).status).toBe(200)

    // A spread-out guesser: 3 more addresses x 10 guesses fills the tenant's 30-per-hour cap for unbound browsers.
    for (let host = 10; host < 13; host++) {
      for (let i = 0; i < 10; i++) await pinLogin(proxied.server, { tenantId, pin: String(7500 + host * 10 + i) }, `198.51.100.${host}`)
    }
    expect((await pinLogin(proxied.server, { tenantId, pin: '1234' }, '192.0.2.99')).status).toBe(429)
    // The enrolled till is outside that cap.
    expect((await pinLogin(proxied.server, { tenantId, pin: '1234', deviceId: till }, '192.0.2.99')).status).toBe(200)
  })

  it("the web server's forwarded client address counts only with the shared proxy secret", async () => {
    process.env.PROXY_SHARED_SECRET = 'e2e-proxy-secret'
    try {
      const { tenantId } = await seedTenant()
      await staff(tenantId, '1234')
      const viaWeb = (pin: string, clientIp: string, secret: string) =>
        request(a.server).post('/pos/v1/auth/login').set('X-Restiq-Client-Ip', clientIp).set('X-Restiq-Proxy-Secret', secret).send({ tenantId, pin })

      // Guesses claiming many addresses without the secret all land on the one real (socket) address.
      for (let i = 0; i < 10; i++) expect((await viaWeb(String(7700 + i), `203.0.113.${i}`, 'wrong-secret')).status).toBe(401)
      expect((await viaWeb('1234', '203.0.113.50', 'wrong-secret')).status).toBe(429)

      // With the secret, each browser behind the web server has its own allowance.
      for (let i = 0; i < 10; i++) expect((await viaWeb(String(7800 + i), '198.51.100.1', 'e2e-proxy-secret')).status).toBe(401)
      expect((await viaWeb('1234', '198.51.100.1', 'e2e-proxy-secret')).status).toBe(429)
      expect((await viaWeb('1234', '198.51.100.2', 'e2e-proxy-secret')).status).toBe(200)
    } finally {
      delete process.env.PROXY_SHARED_SECRET
    }
  })

  it('manager PIN approval: 5 wrong tries per requester, then refused even with the right PIN; another requester is unaffected', async () => {
    const { tenantId } = await seedTenant()
    await staff(tenantId, '4321', 'Manager')
    const managerAuth = a.app.get(ManagerAuthService)
    const cashier = uuidv7()
    for (let i = 0; i < 5; i++) {
      await expect(managerAuth.authorize('refund', tenantId, uuidv7(), String(1000 + i), 'Cold dish', cashier)).rejects.toMatchObject({ status: 401 })
    }
    await expect(managerAuth.authorize('refund', tenantId, uuidv7(), '4321', 'Cold dish', cashier)).rejects.toMatchObject({ status: 429 })
    await expect(managerAuth.authorize('refund', tenantId, uuidv7(), '4321', 'Cold dish', uuidv7())).resolves.toMatchObject({ tenantId })
  })

  it('operator login is limited per account', async () => {
    const email = `ops-${uuidv7()}@restiq.example`
    await prisma.operatorUser.create({ data: { email, passwordHash: await argon2.hash('correct-horse-battery') } })
    for (let i = 0; i < 5; i++) {
      expect((await request(a.server).post('/ops/v1/auth/login').send({ email, password: `wrong-${i}` })).status).toBe(401)
    }
    const locked = await request(b.server).post('/ops/v1/auth/login').send({ email, password: 'correct-horse-battery' })
    expect(locked.status).toBe(429)
  })

  it('a correct PIN gives back its attempt; expired windows start over', async () => {
    const { tenantId } = await seedTenant()
    await staff(tenantId, '1234')
    for (let i = 0; i < 10; i++) await pinLogin(a.server, { tenantId, pin: String(7600 + i) })
    expect((await pinLogin(a.server, { tenantId, pin: '1234' })).status).toBe(429)
    await prisma.$executeRaw`UPDATE auth_attempts SET window_started_at = now() - interval '2 hours'`
    expect((await pinLogin(a.server, { tenantId, pin: '1234' })).status).toBe(200)
    const rows = await prisma.$queryRaw<{ attempts: number }[]>`SELECT attempts FROM auth_attempts WHERE key LIKE ${`pos-pin:ip:${tenantId}:%`}`
    expect(rows.map((r) => r.attempts)).toEqual([0])
  })
})
