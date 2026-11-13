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
  async function enrolHub(seed: Seed, withKey = true): Promise<Hub> {
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
    return { deviceId: (res.body as { device: { id: string } }).device.id, privateKey }
  }

  function signed(hub: Hub, method: 'GET' | 'POST', path: string, body?: unknown, opts?: { timestamp?: number; tamper?: boolean }) {
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const timestamp = String(opts?.timestamp ?? Date.now())
    const message = signingString(method, path, timestamp, raw === undefined ? undefined : Buffer.from(raw))
    const signature = sign(null, Buffer.from(message), hub.privateKey).toString('base64')
    const sent = opts?.tamper && raw ? raw.replace('"', '" ') : raw
    const req = method === 'GET' ? request(httpServer).get(path) : request(httpServer).post(path)
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

      expect((await signed(hub, 'GET', '/sync/v1/session-status', undefined, { timestamp: Date.now() - 6 * 60 * 1000 })).status).toBe(401)
      expect((await signed({ ...hub, deviceId: uuidv7() }, 'GET', '/sync/v1/session-status')).status).toBe(401)
      const other = generateKeyPairSync('ed25519').privateKey
      expect((await signed({ ...hub, privateKey: other }, 'GET', '/sync/v1/session-status')).status).toBe(401)

      const keyless = await enrolHub(seed, false)
      expect((await signed(keyless, 'GET', '/sync/v1/session-status')).status).toBe(401)
      expect((await request(httpServer).get('/sync/v1/session-status')).status).toBe(401)
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
        op('order.line.add', seed.cashierId, { orderId, lineId, itemId: seed.itemId, quantity: 2, unitPriceMinor: '9500' }, at),
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
      expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).unitPriceMinor).toBe(9500n)
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
      const results = await push(hub, [op('order.create', uuidv7(), { orderId: uuidv7(), tableId: seed.tableId }), op('ticket.bump', seed.cashierId, { ticketId: uuidv7() })])
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
        ['ticket.bump', 'unsupported_op'],
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
})
