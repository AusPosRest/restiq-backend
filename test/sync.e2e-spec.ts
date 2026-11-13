// restiq-backend#185: the offline sync device realm. A hub till enrols with an
// ed25519 key, signs every /sync/v1 request, bootstraps, pulls changes and
// pushes the sales it made offline - through the same order and bill services
// as the online POS (AD-18).
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import { generateKeyPairSync, KeyObject, sign } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { OPEN_SALES_TABLES, SyncService } from '../src/pos'
import { signingString, signOpsToken, uuidv7 } from '../src/platform'

const EMAIL = 'sync-operator@restiq.example'

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.cashMovement.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.subscription.deleteMany()
  await prisma.appliedOp.deleteMany()
  await prisma.syncDeadLetter.deleteMany()
  await prisma.printJob.deleteMany()
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
  await prisma.paymentIntent.deleteMany()
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
  await prisma.syncChange.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

interface Hub {
  deviceId: string
  privateKey: KeyObject
}

interface Seed {
  tenantId: string
  outletId: string
  tableId: string
  itemId: string
  cashierId: string
  waiterId: string
}

interface OpResult {
  opId: string
  status: string
  code?: string
}

describe('/sync/v1 (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let opsToken: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    // rawBody, as main.ts: the signature covers the exact bytes.
    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    // #297: shifts and clock events left behind would block other suites' staff wipe.
    await wipe(prisma)
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
  })

  async function seedTenant(name: string): Promise<Seed> {
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
    const brand = await prisma.brand.create({ data: { tenantId, name } })
    const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
    const floor = await prisma.floor.create({ data: { tenantId, outletId: outlet.id, name: 'Ground Floor' } })
    const table = await prisma.diningTable.create({
      data: { tenantId, floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 },
    })
    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Masala dosa', shortName: 'Dosa' } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 10000n, currency: 'INR', channel: 'dine_in' } })
    const cashierRole = await prisma.role.create({ data: { tenantId, name: 'Cashier', isSystem: true, isManager: false } })
    const waiterRole = await prisma.role.create({ data: { tenantId, name: 'Waiter', isSystem: true, isManager: false } })
    const pinHash = await argon2.hash('1234')
    const cashier = await prisma.staffUser.create({ data: { tenantId, roleId: cashierRole.id, name: 'Asha', pinHash } })
    const waiter = await prisma.staffUser.create({ data: { tenantId, roleId: waiterRole.id, name: 'Ravi', pinHash } })
    return { tenantId, outletId: outlet.id, tableId: table.id, itemId: item.id, cashierId: cashier.id, waiterId: waiter.id }
  }

  let enrolIp = 0
  async function enrolHub(seed: Seed, withKey = true, asHub = true): Promise<Hub> {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const codeRes = await request(httpServer)
      .post('/ops/v1/devices/enrolment-codes')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ tenantId: seed.tenantId, outletId: seed.outletId, deviceType: 'pos' })
    expect(codeRes.status).toBe(201)
    // Own address per enrolment, as device-enroll.e2e-spec does, so the
    // per-IP enrolment limit never trips across these tests.
    enrolIp += 1
    const res = await request(httpServer)
      .post('/device/v1/enroll')
      .set('X-Forwarded-For', `10.9.${Math.floor(enrolIp / 250)}.${enrolIp % 250}`)
      .send({
        code: (codeRes.body as { code: string }).code,
        hardwareKeyFingerprint: `hub-${uuidv7()}`,
        ...(withKey && { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }),
      })
    expect(res.status).toBe(201)
    const deviceId = (res.body as { device: { id: string } }).device.id
    if (asHub) await prisma.device.update({ where: { id: deviceId }, data: { role: 'hub' } })
    return { deviceId, privateKey }
  }

  function signed(hub: Hub, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, opts?: { timestamp?: number; tamper?: boolean }) {
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const timestamp = String(opts?.timestamp ?? Date.now())
    const message = signingString(method, path, timestamp, raw === undefined ? undefined : Buffer.from(raw))
    const signature = sign(null, Buffer.from(message), hub.privateKey).toString('base64')
    const sent = opts?.tamper && raw ? raw.replace('"', '" ') : raw
    const req = method === 'GET' ? request(httpServer).get(path) : method === 'PUT' ? request(httpServer).put(path) : request(httpServer).post(path)
    req.set('X-Device-Id', hub.deviceId).set('X-Device-Timestamp', timestamp).set('X-Device-Signature', signature)
    if (sent !== undefined) req.set('Content-Type', 'application/json').send(sent)
    return req
  }

  let seq = 0
  function op(type: string, actorStaffId: string, payload: Record<string, unknown>, at = new Date().toISOString()) {
    seq += 1
    return { opId: uuidv7(), seq, type, at, actorStaffId, payload }
  }

  async function push(hub: Hub, ops: ReturnType<typeof op>[]): Promise<OpResult[]> {
    const res = await signed(hub, 'POST', '/sync/v1/push', { batchId: uuidv7(), ops })
    expect(res.status).toBe(200)
    return (res.body as { results: OpResult[] }).results
  }

  describe('device realm', () => {
    it('accepts a correctly signed request and refuses tampering, an old timestamp, an unknown device and a keyless device', async () => {
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      expect((await signed(hub, 'GET', '/sync/v1/session-status')).status).toBe(200)

      const tampered = await signed(hub, 'POST', '/sync/v1/push', { batchId: uuidv7(), ops: [op('order.create', seed.cashierId, { orderId: uuidv7(), tableId: seed.tableId })] }, { tamper: true })
      expect(tampered.status).toBe(401)
      expect((tampered.body as { error: { code: string } }).error.code).toBe('invalid_signature')

      const skewed = await signed(hub, 'GET', '/sync/v1/session-status', undefined, { timestamp: Date.now() - 6 * 60 * 1000 })
      expect(skewed.status).toBe(401)
      // issue #195: a wrong clock says so, with RESTIQ's time, so the till can be fixed.
      expect((skewed.body as { error: { code: string; serverTime: string } }).error.code).toBe('clock_skew')
      expect(Math.abs(Date.parse((skewed.body as { error: { serverTime: string } }).error.serverTime) - Date.now())).toBeLessThan(60_000)
      expect((await signed({ ...hub, deviceId: uuidv7() }, 'GET', '/sync/v1/session-status')).status).toBe(401)
      const other = generateKeyPairSync('ed25519').privateKey
      expect((await signed({ ...hub, privateKey: other }, 'GET', '/sync/v1/session-status')).status).toBe(401)

      const keyless = await enrolHub(seed, false)
      expect((await signed(keyless, 'GET', '/sync/v1/session-status')).status).toBe(401)
      expect((await request(httpServer).get('/sync/v1/session-status')).status).toBe(401)
    })

    it('lets only the hub bootstrap and push (403 not_hub), and says which it is', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const till = await enrolHub(seed, true, false)
      for (const res of [
        await signed(till, 'GET', '/sync/v1/bootstrap'),
        await signed(till, 'POST', '/sync/v1/push', { batchId: uuidv7(), ops: [op('order.create', seed.cashierId, { orderId: uuidv7(), tokenNumber: 1 })] }),
      ]) {
        expect(res.status).toBe(403)
        expect((res.body as { error: { code: string } }).error.code).toBe('not_hub')
      }
      expect(await prisma.order.count({ where: { tenantId: seed.tenantId } })).toBe(0)
      expect(((await signed(till, 'GET', '/sync/v1/session-status')).body as { isHub: boolean }).isHub).toBe(false)
      const hub = await enrolHub(seed)
      expect(((await signed(hub, 'GET', '/sync/v1/session-status')).body as { isHub: boolean }).isHub).toBe(true)
    })

    it('refuses a revoked device with 403 device_revoked', async () => {
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      await prisma.device.update({ where: { id: hub.deviceId }, data: { status: 'revoked', revokedAt: new Date() } })
      const res = await signed(hub, 'GET', '/sync/v1/session-status')
      expect(res.status).toBe(403)
      expect((res.body as { error: { code: string } }).error.code).toBe('device_revoked')
    })

    it('rejects enrolment with a key that is not ed25519, without using up the code', async () => {
      const seed = await seedTenant('Spice Route')
      const codeRes = await request(httpServer)
        .post('/ops/v1/devices/enrolment-codes')
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ tenantId: seed.tenantId, outletId: seed.outletId, deviceType: 'pos' })
      const code = (codeRes.body as { code: string }).code
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
      const bad = await request(httpServer).post('/device/v1/enroll').send({ code, hardwareKeyFingerprint: 'fp', publicKey: rsa.slice(0, 200) })
      expect(bad.status).toBe(400)
      expect((await prisma.enrolmentCode.findFirst({ where: { tenantId: seed.tenantId } }))?.usedAt).toBeNull()
    })
  })

  describe('bootstrap, pull, session status', () => {
    it('bootstraps the outlet, then pulls a price change made after it, and never another tenant\'s change', async () => {
      const seed = await seedTenant('Spice Route')
      const other = await seedTenant('Other Place')
      const hub = await enrolHub(seed)
      // Changes become visible to pull once settled (30 s); age the seed rows.
      await prisma.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '1 minute'`

      const boot = await signed(hub, 'GET', '/sync/v1/bootstrap')
      expect(boot.status).toBe(200)
      const body = boot.body as { cursor: string; outletId: string; policy: { maxOfflineHours: number }; permissions: Record<string, string[]>; data: Record<string, Record<string, unknown>[]> }
      expect(body.outletId).toBe(seed.outletId)
      expect(body.policy.maxOfflineHours).toBe(24)
      expect(body.permissions.Cashier).toContain('settle_bills')
      expect(body.data.menu_items.map((r) => r.id)).toEqual([seed.itemId])
      expect(body.data.dining_tables.map((r) => r.id)).toEqual([seed.tableId])
      expect(body.data.outlets.map((r) => r.id)).toEqual([seed.outletId])
      expect(body.data.staff_users.find((r) => r.id === seed.cashierId)?.pin_hash).toEqual(expect.stringContaining('$argon2'))
      // #292: the hub's own tenant row (never another tenant's) and its brands.
      expect(body.data.tenants).toHaveLength(1)
      expect(body.data.tenants[0]).toMatchObject({ id: seed.tenantId, name: 'Spice Route', country: 'IN', status: 'active', max_offline_hours: 24, deleted_at: null })
      expect(body.data.tenants[0]).toHaveProperty('live_since')
      expect(body.data.brands.map((r) => r.tenant_id)).toEqual([seed.tenantId])

      await prisma.itemPrice.updateMany({ where: { itemId: seed.itemId }, data: { priceMinor: 12000n } })
      await prisma.itemPrice.updateMany({ where: { itemId: other.itemId }, data: { priceMinor: 99900n } })
      await prisma.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '1 minute'`

      const pull = await signed(hub, 'GET', `/sync/v1/pull?cursor=${body.cursor}`)
      expect(pull.status).toBe(200)
      const changes = (pull.body as { changes: { entity: string; action: string; data?: Record<string, unknown> }[] }).changes
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ entity: 'item_prices', action: 'upsert' })
      expect(changes[0]?.data?.price_minor).toBe(12000)

      expect((await signed(hub, 'GET', '/sync/v1/pull?cursor=abc')).status).toBe(400)

      // #292: a tenant change (here going Live) reaches the hub through pull.
      const cursor2 = (pull.body as { nextCursor: string }).nextCursor
      await prisma.tenant.update({ where: { id: seed.tenantId }, data: { liveSince: null } })
      await prisma.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '1 minute'`
      const pull2 = await signed(hub, 'GET', `/sync/v1/pull?cursor=${cursor2}`)
      const tenantChanges = (pull2.body as { changes: unknown[] }).changes
      expect(tenantChanges).toHaveLength(1)
      expect(tenantChanges[0]).toMatchObject({ entity: 'tenants', id: seed.tenantId, data: { live_since: null } })
    })

    it('answers 410 cursor_expired for a cursor older than the kept 30 days, and bootstrap still works', async () => {
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      await prisma.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '1 minute'`
      const oldCursor = ((await signed(hub, 'GET', '/sync/v1/bootstrap')).body as { cursor: string }).cursor

      // Two later changes; then everything up to the first one ages past 30 days.
      await prisma.itemPrice.updateMany({ where: { itemId: seed.itemId }, data: { priceMinor: 12000n } })
      await prisma.itemPrice.updateMany({ where: { itemId: seed.itemId }, data: { priceMinor: 13000n } })
      const newest = await prisma.syncChange.findFirstOrThrow({ where: { tenantId: seed.tenantId }, orderBy: { id: 'desc' } })
      await prisma.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '31 days' WHERE id < ${newest.id}`
      await prisma.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '1 minute' WHERE id = ${newest.id}`
      await app.get(SyncService).prune()
      // The newest change of a tenant is always kept.
      expect(await prisma.syncChange.count({ where: { tenantId: seed.tenantId } })).toBe(1)

      const expired = await signed(hub, 'GET', `/sync/v1/pull?cursor=${oldCursor}`)
      expect(expired.status).toBe(410)
      expect((expired.body as { error: { code: string } }).error.code).toBe('cursor_expired')
      expect((await signed(hub, 'GET', '/sync/v1/pull?cursor=0')).status).toBe(200)

      const again = await signed(hub, 'GET', '/sync/v1/bootstrap')
      expect(again.status).toBe(200)
      const cursor = (again.body as { cursor: string }).cursor
      expect(cursor).toBe(newest.id.toString())
      expect((await signed(hub, 'GET', `/sync/v1/pull?cursor=${cursor}`)).status).toBe(200)
    })

    it('records a signed heartbeat that ops sync-health shows', async () => {
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const beat = { outboxDepth: 17, appVersion: '1.4.0', clockSkewSeconds: -3, recentRejectionCount: 2 }
      expect((await signed(hub, 'POST', '/sync/v1/heartbeat', beat)).status).toBe(204)
      expect((await signed(hub, 'POST', '/sync/v1/heartbeat', { ...beat, outboxDepth: -1 })).status).toBe(400)

      const health = await request(httpServer).get(`/ops/v1/sync-health?tenantId=${seed.tenantId}`).set('Authorization', `Bearer ${opsToken}`)
      expect(health.status).toBe(200)
      const row = (health.body as { devices: Record<string, unknown>[] }).devices.find((d) => d.deviceId === hub.deviceId)
      expect(row).toMatchObject({ ...beat, severity: 'healthy' })
    })

    it('says when the hub must sync by', async () => {
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      await signed(hub, 'GET', '/sync/v1/bootstrap')
      const res = await signed(hub, 'GET', '/sync/v1/session-status')
      const status = res.body as { active: boolean; revoked: boolean; mustSyncBefore: string }
      expect(status).toMatchObject({ active: true, revoked: false })
      const hours = (new Date(status.mustSyncBefore).getTime() - Date.now()) / 3600_000
      expect(hours).toBeGreaterThan(23.9)
      expect(hours).toBeLessThanOrEqual(24)
    })
  })

  describe('hub address and open sales (#301)', () => {
    it('lets the hub announce its LAN address and any device in its outlet look it up', async () => {
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const till = await enrolHub(seed, true, false)
      const otherSeed = await seedTenant('Other Place')
      const otherOutletTill = await enrolHub(otherSeed, true, false)

      const none = await signed(till, 'GET', '/sync/v1/hub')
      expect(none.status).toBe(404)
      expect((none.body as { error: { code: string } }).error.code).toBe('no_hub')

      const urls = ['http://192.168.1.20:8080', 'http://till-1.local:8080']
      expect((await signed(hub, 'PUT', '/sync/v1/hub-address', { urls })).status).toBe(204)
      const found = await signed(till, 'GET', '/sync/v1/hub')
      expect(found.status).toBe(200)
      expect(found.body).toMatchObject({ deviceId: hub.deviceId, urls })
      expect(Math.abs(Date.parse((found.body as { announcedAt: string }).announcedAt) - Date.now())).toBeLessThan(60_000)

      const elsewhere = await signed(otherOutletTill, 'GET', '/sync/v1/hub')
      expect(elsewhere.status).toBe(404)
      expect((elsewhere.body as { error: { code: string } }).error.code).toBe('no_hub')
    })

    it('refuses a public IP, a missing port, too many URLs and a non-hub device', async () => {
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const till = await enrolHub(seed, true, false)
      for (const urls of [['http://8.8.8.8:8080'], ['http://192.168.1.20'], [], ['http://10.0.0.1:1', 'http://10.0.0.1:2', 'http://10.0.0.1:3', 'http://10.0.0.1:4', 'http://10.0.0.1:5']]) {
        expect((await signed(hub, 'PUT', '/sync/v1/hub-address', { urls })).status).toBe(400)
      }
      const notHub = await signed(till, 'PUT', '/sync/v1/hub-address', { urls: ['http://10.0.0.9:8080'] })
      expect(notHub.status).toBe(403)
      expect((notHub.body as { error: { code: string } }).error.code).toBe('not_hub')
      expect(await prisma.device.count({ where: { tenantId: seed.tenantId, lanAnnouncedAt: { not: null } } })).toBe(0)
    })

    it('bootstrap?include=open_sales adds the outlet\'s open orders, bills, queued tickets and open shift; plain bootstrap is unchanged', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const openOrderId = uuidv7()
      const openLineId = uuidv7()
      const openBillId = uuidv7()
      const closedOrderId = uuidv7()
      const closedBillId = uuidv7()
      const shiftId = uuidv7()
      const movementId = uuidv7()
      const ops = [
        op('shift.open', seed.cashierId, { shiftId, outletId: seed.outletId, floatMinor: 5000 }),
        op('shift.cash_movement', seed.cashierId, { shiftId, movementId, type: 'paid_out', amountMinor: 1200, reason: 'Milk' }),
        op('order.create', seed.cashierId, { orderId: openOrderId, tableId: seed.tableId }),
        op('order.line.add', seed.cashierId, { orderId: openOrderId, lineId: openLineId, itemId: seed.itemId, quantity: 1, unitPriceMinor: '10000' }),
        op('order.status', seed.cashierId, { orderId: openOrderId, status: 'sent' }),
        op('bill.create', seed.cashierId, { orderId: openOrderId, billId: openBillId }),
        op('order.create', seed.cashierId, { orderId: closedOrderId, tokenNumber: 7 }),
        op('order.line.add', seed.cashierId, { orderId: closedOrderId, lineId: uuidv7(), itemId: seed.itemId, quantity: 1, unitPriceMinor: '10000' }),
        op('bill.create', seed.cashierId, { orderId: closedOrderId, billId: closedBillId }),
      ]
      expect((await push(hub, ops)).map((r) => r.status)).toEqual(ops.map(() => 'accepted'))
      const closedBill = await prisma.bill.findUniqueOrThrow({ where: { id: closedBillId } })
      const total = Number(closedBill.pricesIncludeTax ? closedBill.subtotalMinor : closedBill.subtotalMinor + closedBill.taxMinor)
      const finalize = op('bill.finalize', seed.cashierId, { billId: closedBillId, tenders: [{ method: 'cash', amountMinor: total }], tenderIds: [uuidv7()] })
      expect((await push(hub, [finalize])).map((r) => r.status)).toEqual(['accepted'])
      expect((await prisma.order.findUniqueOrThrow({ where: { id: closedOrderId } })).status).toBe('closed')

      const plain = await signed(hub, 'GET', '/sync/v1/bootstrap')
      expect(Object.keys(plain.body as object).sort()).toEqual(['cursor', 'data', 'outletId', 'permissions', 'policy'])
      expect(Object.keys((plain.body as { data: object }).data)).not.toContain('orders')

      const boot = await signed(hub, 'GET', '/sync/v1/bootstrap?include=open_sales')
      expect(boot.status).toBe(200)
      const open = (boot.body as { openSales: Record<string, Record<string, unknown>[]> }).openSales
      const ids = (table: string) => open[table].map((r) => r.id)
      expect(Object.keys(open)).toEqual([...OPEN_SALES_TABLES])
      expect(ids('orders')).toEqual([openOrderId])
      expect(ids('order_lines')).toEqual([openLineId])
      expect(ids('bills')).toEqual([openBillId])
      expect(open.tenders).toEqual([])
      // Queued tickets go by ticket, not order: a paid counter order still cooking keeps its ticket.
      const ticket = open.tickets.find((r) => r.order_id === openOrderId)
      expect(ticket).toMatchObject({ status: 'queued' })
      expect(open.tickets.every((r) => r.status === 'queued')).toBe(true)
      expect(open.ticket_lines.filter((r) => r.ticket_id === ticket?.id).map((r) => r.order_line_id)).toEqual([openLineId])
      expect(ids('shifts')).toEqual([shiftId])
      expect(ids('cash_movements')).toEqual([movementId])
      expect(open.token_number_counters.every((r) => r.outlet_id === seed.outletId)).toBe(true)
      // The rest of the payload is the plain bootstrap's.
      expect((boot.body as { data: object }).data).toEqual((plain.body as { data: object }).data)
    })
  })

  describe('push', () => {
    it('applies an offline sale with the hub\'s ids, time and price, and answers a re-send with duplicate', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const orderId = uuidv7()
      const lineId = uuidv7()
      const billId = uuidv7()
      const at = '2026-10-07T09:58:00.000Z'
      // The hub charged 9500 (its menu was older than the cloud's 10000).
      const sale = [
        op('order.create', seed.cashierId, { orderId, tableId: seed.tableId }, at),
        op('order.line.add', seed.cashierId, { orderId, lineId, itemId: seed.itemId, quantity: 2, unitPriceMinor: '9500', note: 'less spicy' }, at),
        op('order.status', seed.cashierId, { orderId, status: 'sent' }, at),
        op('bill.create', seed.cashierId, { orderId, billId }, at),
      ]
      expect((await push(hub, sale)).map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted'])

      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } })
      expect(bill.subtotalMinor).toBe(19000n)
      const total = bill.pricesIncludeTax ? bill.subtotalMinor : bill.subtotalMinor + bill.taxMinor
      const tenderId = uuidv7()
      const finalize = op('bill.finalize', seed.cashierId, { billId, tenders: [{ method: 'cash', amountMinor: Number(total) }], tenderIds: [tenderId] }, at)
      expect((await push(hub, [finalize])).map((r) => r.status)).toEqual(['accepted'])

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
      expect(order.createdAt.toISOString()).toBe(at)
      expect(order.status).toBe('closed')
      const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })
      expect(line.unitPriceMinor).toBe(9500n)
      expect(line.note).toBe('less spicy') // #292: the note survives the push
      const tender = await prisma.tender.findUniqueOrThrow({ where: { id: tenderId } })
      expect(tender.createdAt.toISOString()).toBe(at)
      expect((await prisma.bill.findUniqueOrThrow({ where: { id: billId } })).status).toBe('finalized')

      const again = await push(hub, [...sale, finalize])
      expect(again.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate'])
      expect(await prisma.tender.count({ where: { billId } })).toBe(1)
      expect(await prisma.order.count({ where: { tenantId: seed.tenantId } })).toBe(1)
    })

    it('defers everything after a gap in seq and applies none of it', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const first = op('order.create', seed.cashierId, { orderId: uuidv7(), tableId: seed.tableId })
      seq += 1 // seq 2 never sent
      const third = op('order.create', seed.cashierId, { orderId: uuidv7(), tokenNumber: 7 })
      const results = await push(hub, [first, third])
      expect(results.map((r) => [r.status, r.code])).toEqual([
        ['accepted', undefined],
        ['deferred', 'seq_gap'],
      ])
      expect(await prisma.order.count({ where: { tenantId: seed.tenantId } })).toBe(1)
    })

    it('keeps a sale settled by someone who lost settle_bills, and audits it (decision S3)', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const orderId = uuidv7()
      const billId = uuidv7()
      // Waiter: take_orders + fire_kitchen only.
      await push(hub, [
        op('order.create', seed.waiterId, { orderId, tokenNumber: 41 }),
        op('order.line.add', seed.waiterId, { orderId, lineId: uuidv7(), itemId: seed.itemId, quantity: 1, unitPriceMinor: '10000' }),
        op('bill.create', seed.waiterId, { orderId, billId }),
      ])
      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } })
      const total = bill.pricesIncludeTax ? bill.subtotalMinor : bill.subtotalMinor + bill.taxMinor
      const results = await push(hub, [op('bill.finalize', seed.waiterId, { billId, tenders: [{ method: 'cash', amountMinor: Number(total) }], tenderIds: [uuidv7()] })])
      expect(results[0]?.status).toBe('accepted')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).tokenNumber).toBe(41)
      const audit = await prisma.auditEvent.findMany({ where: { tenantId: seed.tenantId, action: 'sync.permission_lapsed' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.actorId).toBe(seed.waiterId)
    })

    it('rejects an unknown staff member and an unsupported op into the Sync issues list, and acknowledges them', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const results = await push(hub, [op('order.create', uuidv7(), { orderId: uuidv7(), tableId: seed.tableId }), op('bill.refund', seed.cashierId, { billId: uuidv7() })])
      expect(results.map((r) => [r.status, r.code])).toEqual([
        ['rejected', 'unknown_staff'],
        ['rejected', 'unsupported_op'],
      ])
      // Rejected ops still use up their seq: the next op is 3.
      expect((await push(hub, [op('order.create', seed.cashierId, { orderId: uuidv7(), tokenNumber: 1 })]))[0]?.status).toBe('accepted')

      const list = await signed(hub, 'GET', '/sync/v1/rejections')
      const rejections = list.body as { opId: string; type: string; code: string; acknowledged: boolean }[]
      expect(rejections.map((r) => [r.type, r.code])).toEqual([
        ['order.create', 'unknown_staff'],
        ['bill.refund', 'unsupported_op'],
      ])
      expect((await signed(hub, 'POST', `/sync/v1/rejections/${rejections[0]?.opId}/acknowledge`)).status).toBe(204)
      expect(((await signed(hub, 'GET', '/sync/v1/rejections')).body as unknown[]).length).toBe(1)
      expect((await signed(hub, 'POST', `/sync/v1/rejections/${uuidv7()}/acknowledge`)).status).toBe(404)
    })

    it('cannot touch another tenant\'s order', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const other = await seedTenant('Other Place')
      const hub = await enrolHub(seed)
      const otherOrder = await prisma.order.create({ data: { tenantId: other.tenantId, outletId: other.outletId, tableId: other.tableId, ownerId: other.cashierId, status: 'open' } })
      const results = await push(hub, [op('order.line.add', seed.cashierId, { orderId: otherOrder.id, lineId: uuidv7(), itemId: seed.itemId, quantity: 1, unitPriceMinor: '1' })])
      expect(results[0]?.status).toBe('rejected')
      expect(await prisma.orderLine.count({ where: { orderId: otherOrder.id } })).toBe(0)
    })

    it('refuses a batch over 200 ops with 413 batch_too_large', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const ops = Array.from({ length: 201 }, () => op('order.create', seed.cashierId, { orderId: uuidv7(), tokenNumber: 1 }))
      const res = await signed(hub, 'POST', '/sync/v1/push', { batchId: uuidv7(), ops })
      expect(res.status).toBe(413)
      expect((res.body as { error: { code: string } }).error.code).toBe('batch_too_large')
    })
  })

  // restiq-backend#297 (B5a/B5b): every other write the hub makes.
  describe('push: combos, voids, transfers, discards, shifts, clock, tickets', () => {
    async function staffWithRole(seed: Seed, role: string, name: string): Promise<string> {
      const r = await prisma.role.create({ data: { tenantId: seed.tenantId, name: role, isSystem: true, isManager: role === 'Manager' } })
      return (await prisma.staffUser.create({ data: { tenantId: seed.tenantId, roleId: r.id, name, pinHash: 'x' } })).id
    }

    async function comboFixture(seed: Seed) {
      const combo = await prisma.combo.create({ data: { tenantId: seed.tenantId, name: 'Thali', priceMinor: 30000n, currency: 'INR' } })
      const group = await prisma.modifierGroup.create({ data: { tenantId: seed.tenantId, name: 'Extras', minSelections: 0, maxSelections: 2 } })
      const modifier = await prisma.modifier.create({ data: { tenantId: seed.tenantId, groupId: group.id, name: 'Ghee', priceMinor: 2000n, sortOrder: 0 } })
      return { comboId: combo.id, modifierId: modifier.id }
    }

    it('applies a combo, a void, a transfer and a discard with the hub\'s ids, time and prices; a re-send is all duplicate', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const managerId = await staffWithRole(seed, 'Manager', 'Meera')
      const { comboId, modifierId } = await comboFixture(seed)
      // The combo was taken off the menu in the cloud after the hub sold it (S3: kept).
      await prisma.combo.update({ where: { id: comboId }, data: { archivedAt: new Date() } })
      const at = '2026-10-07T10:15:00.000Z'
      const orderId = uuidv7()
      const parentId = uuidv7()
      const childId = uuidv7()
      const lineId = uuidv7()
      const counterId = uuidv7()
      const ops = [
        op('order.create', seed.cashierId, { orderId, tableId: seed.tableId }, at),
        op('order.combo.add', seed.cashierId, {
          orderId, lineId: parentId, comboId, quantity: 2, unitPriceMinor: '28000',
          children: [{ lineId: childId, itemId: seed.itemId, quantity: 2, unitPriceMinor: '500', modifierPriceMinor: { [modifierId]: '1500' } }],
        }, at),
        op('order.line.add', seed.cashierId, { orderId, lineId, itemId: seed.itemId, quantity: 1, unitPriceMinor: '10000' }, at),
        op('order.status', seed.cashierId, { orderId, status: 'sent' }, at),
        op('order.line.void', seed.cashierId, { orderId, lineId, reason: 'Guest changed mind', approvedByStaffId: managerId }, at),
        op('order.transfer', seed.cashierId, { orderId, newOwnerStaffId: seed.waiterId }, at),
        op('order.create', seed.cashierId, { orderId: counterId, tokenNumber: 9 }, at),
        op('order.discard', seed.cashierId, { orderId: counterId }, at),
      ]
      expect((await push(hub, ops)).map((r) => [r.status, r.code])).toEqual(ops.map(() => ['accepted', undefined]))

      const parent = await prisma.orderLine.findUniqueOrThrow({ where: { id: parentId } })
      expect(parent).toMatchObject({ comboId, quantity: 2, unitPriceMinor: 28000n })
      expect(parent.createdAt.toISOString()).toBe(at)
      const child = await prisma.orderLine.findUniqueOrThrow({ where: { id: childId }, include: { modifiers: true } })
      expect(child).toMatchObject({ parentLineId: parentId, quantity: 2, unitPriceMinor: 500n })
      expect(child.modifiers.map((m) => [m.modifierId, m.priceMinor])).toEqual([[modifierId, 1500n]])

      const voided = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })
      expect(voided.voidedAt?.toISOString()).toBe(at)
      expect(voided.voidReason).toBe('Guest changed mind')
      const approval = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: seed.tenantId, action: 'sync.void_approved_offline' } })
      expect(approval).toMatchObject({ actorId: seed.cashierId, approverId: managerId, approverName: 'Meera', reason: 'Guest changed mind' })
      expect(approval.occurredAt.toISOString()).toBe(at)

      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).ownerId).toBe(seed.waiterId)
      const transferred = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: seed.tenantId, action: 'order.ownership_transferred' } })
      expect(transferred.occurredAt.toISOString()).toBe(at)
      expect(await prisma.order.count({ where: { id: counterId } })).toBe(0)
      expect((await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: seed.tenantId, action: 'order.discarded' } })).occurredAt.toISOString()).toBe(at)

      const again = await push(hub, ops)
      expect(again.map((r) => r.status)).toEqual(ops.map(() => 'duplicate'))
      expect(await prisma.orderLine.count({ where: { orderId } })).toBe(3)
      expect(await prisma.auditEvent.count({ where: { tenantId: seed.tenantId, action: { in: ['sync.void_approved_offline', 'order.ownership_transferred', 'order.discarded'] } } })).toBe(3)
    })

    it('rejects a void approved by someone who is not staff here', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const other = await seedTenant('Other Place')
      const hub = await enrolHub(seed)
      const orderId = uuidv7()
      const lineId = uuidv7()
      const results = await push(hub, [
        op('order.create', seed.cashierId, { orderId, tokenNumber: 3 }),
        op('order.line.add', seed.cashierId, { orderId, lineId, itemId: seed.itemId, quantity: 1, unitPriceMinor: '10000' }),
        op('order.status', seed.cashierId, { orderId, status: 'sent' }),
        op('order.line.void', seed.cashierId, { orderId, lineId, reason: 'Wrong item', approvedByStaffId: other.cashierId }),
        op('order.line.void', seed.cashierId, { orderId, lineId, reason: 'Wrong item' }),
      ])
      expect(results.map((r) => [r.status, r.code])).toEqual([
        ['accepted', undefined],
        ['accepted', undefined],
        ['accepted', undefined],
        ['rejected', 'validation_failed'],
        ['rejected', 'invalid_payload'],
      ])
      expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).voidedAt).toBeNull()
    })

    it('applies a shift, cash movement, clock in/out and a ticket bump and recall at the hub\'s time; a re-send is all duplicate', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const at = '2026-10-07T11:00:00.000Z'
      const later = '2026-10-07T11:05:00.000Z'
      const shiftId = uuidv7()
      const movementId = uuidv7()
      const clockInId = uuidv7()
      const clockOutId = uuidv7()
      const orderId = uuidv7()
      const ops = [
        op('shift.open', seed.cashierId, { shiftId, outletId: seed.outletId, floatMinor: 5000 }, at),
        op('clock.in', seed.cashierId, { clockEventId: clockInId }, at),
        op('order.create', seed.cashierId, { orderId, tokenNumber: 5 }, at),
        op('order.line.add', seed.cashierId, { orderId, lineId: uuidv7(), itemId: seed.itemId, quantity: 1, unitPriceMinor: '10000' }, at),
        op('order.status', seed.cashierId, { orderId, status: 'sent' }, at),
        op('ticket.bump', seed.cashierId, { orderId, stationId: null }, at),
        op('ticket.recall', seed.cashierId, { orderId, stationId: null }, later),
        op('shift.cash_movement', seed.cashierId, { shiftId, movementId, type: 'paid_out', amountMinor: 1200, reason: 'Milk' }, at),
        op('shift.close', seed.cashierId, { shiftId, countedMinor: 3800 }, later),
        op('clock.out', seed.cashierId, { clockEventId: clockOutId }, later),
      ]
      expect((await push(hub, ops)).map((r) => [r.status, r.code])).toEqual(ops.map(() => ['accepted', undefined]))

      const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
      expect(shift.openedAt.toISOString()).toBe(at)
      expect(shift.closedAt?.toISOString()).toBe(later)
      expect(shift).toMatchObject({ floatMinor: 5000n, countedMinor: 3800n, expectedMinor: 3800n, overShortMinor: 0n })
      const movement = await prisma.cashMovement.findUniqueOrThrow({ where: { id: movementId } })
      expect(movement.createdAt.toISOString()).toBe(at)
      const clock = await prisma.clockEvent.findMany({ where: { staffId: seed.cashierId }, orderBy: { occurredAt: 'asc' } })
      expect(clock.map((c) => [c.id, c.type, c.occurredAt.toISOString()])).toEqual([
        [clockInId, 'clock_in', at],
        [clockOutId, 'clock_out', later],
      ])
      // Synced weeks after the cloud's own recall window (now - bumpedAt) - still kept.
      const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderId } })
      expect(ticket).toMatchObject({ status: 'queued', recallCount: 1 })
      expect(ticket.bumpedAt?.toISOString()).toBe(at)
      expect(ticket.recalledAt?.toISOString()).toBe(later)

      const again = await push(hub, ops)
      expect(again.map((r) => r.status)).toEqual(ops.map(() => 'duplicate'))
      expect(await prisma.clockEvent.count({ where: { staffId: seed.cashierId } })).toBe(2)
      expect(await prisma.ticketEvent.count({ where: { ticketId: ticket.id } })).toBe(2)
    })

    it('rejects a bump for an order with no ticket and a shift for another outlet', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      const results = await push(hub, [
        op('ticket.bump', seed.cashierId, { orderId: uuidv7(), stationId: null }),
        op('ticket.bump', seed.cashierId, { orderId: uuidv7() }),
        op('shift.open', seed.cashierId, { shiftId: uuidv7(), outletId: uuidv7(), floatMinor: 0 }),
      ])
      expect(results.map((r) => [r.status, r.code])).toEqual([
        ['rejected', 'not_found'],
        ['rejected', 'invalid_payload'],
        ['rejected', 'invalid_payload'],
      ])
    })

    it('keeps every one of these done by someone who lost the permission, and audits each (decision S3)', async () => {
      seq = 0
      const seed = await seedTenant('Spice Route')
      const hub = await enrolHub(seed)
      // Kitchen: fire_kitchen only - no take_orders, no settle_bills.
      const cookId = await staffWithRole(seed, 'Kitchen', 'Kiran')
      const managerId = await staffWithRole(seed, 'Manager', 'Meera')
      const { comboId } = await comboFixture(seed)
      const orderId = uuidv7()
      const lineId = uuidv7()
      const shiftId = uuidv7()
      const ops = [
        op('order.create', cookId, { orderId, tableId: seed.tableId }),
        op('order.combo.add', cookId, { orderId, lineId: uuidv7(), comboId, quantity: 1, unitPriceMinor: '30000', children: [{ lineId: uuidv7(), itemId: seed.itemId, quantity: 1, unitPriceMinor: '0' }] }),
        op('order.line.add', cookId, { orderId, lineId, itemId: seed.itemId, quantity: 1, unitPriceMinor: '10000' }),
        op('order.status', cookId, { orderId, status: 'sent' }),
        op('ticket.bump', cookId, { orderId, stationId: null }),
        op('order.line.void', cookId, { orderId, lineId, reason: 'Burnt', approvedByStaffId: managerId }),
        op('shift.open', cookId, { shiftId, outletId: seed.outletId, floatMinor: 0 }),
        op('shift.cash_movement', cookId, { shiftId, movementId: uuidv7(), type: 'bank_drop', amountMinor: 1, reason: 'Drop' }),
        op('shift.close', cookId, { shiftId, countedMinor: 0 }),
        op('order.transfer', cookId, { orderId, newOwnerStaffId: seed.waiterId }),
      ]
      expect((await push(hub, ops)).map((r) => [r.status, r.code])).toEqual(ops.map(() => ['accepted', undefined]))
      const lapsed = await prisma.auditEvent.findMany({ where: { tenantId: seed.tenantId, action: 'sync.permission_lapsed' } })
      // Everything but order.status and ticket.bump needs take_orders or settle_bills.
      expect(lapsed.map((a) => a.reason.split(' ')[0]).sort()).toEqual(
        ['order.create', 'order.combo.add', 'order.line.add', 'order.line.void', 'shift.open', 'shift.cash_movement', 'shift.close', 'order.transfer'].sort(),
      )

      // Discard needs every line gone; a fresh counter order shows it too.
      const counterId = uuidv7()
      const discard = await push(hub, [op('order.create', cookId, { orderId: counterId, tokenNumber: 2 }), op('order.discard', cookId, { orderId: counterId })])
      expect(discard.map((r) => r.status)).toEqual(['accepted', 'accepted'])
      expect(await prisma.auditEvent.count({ where: { tenantId: seed.tenantId, action: 'sync.permission_lapsed', reason: { startsWith: 'order.discard ' } } })).toBe(1)
    })
  })
})
