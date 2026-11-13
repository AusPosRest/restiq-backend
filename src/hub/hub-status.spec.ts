// Hub status, O1 lock and Sync issues (#307, HUB-BUILD-PLAN H6) on in-memory
// PGlite with a fake clock and a fake cloud for acknowledgements.
// First, as in hub.module: pos and admin import each other.
import '../pos'
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import * as argon2 from 'argon2'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HUB_PIN, seedSaleFixture, seedTenantRows, type SaleFixture } from '../../test/hub-seed'
import { setPrismaClient } from '../db/client'
import { uuidv7 } from '../platform'
import { computeTax } from '../pos/bills/tax'
import { createHubApp } from './hub.module'
import { applyPull } from './import'
import { HubContext } from './lock.guard'
import { APP_ROLE, openStore } from './store'
import { SyncWorker } from './sync-worker'

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations')
const WAITER_PIN = '5555'
const HOUR = 3_600_000

describe('hub status, O1 lock and rejections', () => {
  let pg: PGlite
  let app: INestApplication
  let http: Parameters<typeof request>[0]
  let f: SaleFixture
  let cashier: Record<string, string>
  let waiter: Record<string, string>
  let now = new Date()
  let worker: SyncWorker | undefined
  let cloud: Server
  const acked: string[] = []
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-status-'))

  const asSuper = async <T>(fn: () => Promise<T>): Promise<T> => {
    await pg.exec('RESET ROLE')
    try {
      return await fn()
    } finally {
      await pg.exec(`SET ROLE ${APP_ROLE}`)
    }
  }
  const login = async (pin: string) => {
    const res = await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin }).expect(200)
    return { Authorization: `Bearer ${(res.body as { token: string }).token}` }
  }
  const lastSync = async () => (await pg.query<{ t: Date }>('SELECT last_sync_at AS t FROM hub_meta')).rows[0].t
  const addRejection = (opId: string) =>
    pg.query(`INSERT INTO hub_rejections (op_id, type, code, message, at) VALUES ($1, 'order.create', 'outlet_closed', 'Outlet is closed', now())`, [opId])

  beforeAll(async () => {
    process.env.POS_JWT_SECRET = 'hub-status-spec-secret'
    const store = await openStore(undefined, MIGRATIONS)
    pg = store.pg
    setPrismaClient(store.prisma)
    await asSuper(async () => {
      f = await seedSaleFixture(store.prisma, await seedTenantRows(store.prisma, 'Status'))
      const role = await store.prisma.role.create({ data: { tenantId: f.tenantId, name: 'Waiter', isSystem: true, isManager: false } })
      await store.prisma.staffUser.create({ data: { tenantId: f.tenantId, roleId: role.id, name: 'Wasim', pinHash: await argon2.hash(WAITER_PIN), pinIssuedAt: new Date() } })
      await pg.query(
        `INSERT INTO hub_meta (tenant_id, outlet_id, cursor, policy, permissions, last_sync_at, online)
         VALUES ($1, $2, 0, '{"maxOfflineHours": 24, "syncIntervalSeconds": 30}', '{}', now(), true)`,
        [f.tenantId, f.outletId],
      )
    })

    cloud = createServer((req, res) => {
      const match = /^\/sync\/v1\/rejections\/([^/]+)\/acknowledge$/.exec(req.url ?? '')
      if (req.method === 'POST' && match) acked.push(match[1])
      res.writeHead(match ? 204 : 404).end()
    })
    await new Promise<void>((resolve) => cloud.listen(0, '127.0.0.1', resolve))
    const key = generateKeyPairSync('ed25519').privateKey
    worker = new SyncWorker({ pg, dataDir, cloudUrl: `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`, deviceId: uuidv7(), key, appVersion: 'spec' })

    app = await createHubApp(pg, dataDir, undefined, new HubContext(pg, () => now, () => worker))
    await app.init()
    http = app.getHttpServer() as Parameters<typeof request>[0]
    cashier = await login(HUB_PIN)
    waiter = await login(WAITER_PIN)
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pg?.close()
    cloud?.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('reports the hub status to any staff', async () => {
    const at = await lastSync()
    now = new Date(at.getTime() + HOUR)
    const res = await request(http).get('/pos/v1/hub/status').set(waiter).expect(200)
    expect(res.body).toEqual({
      online: true,
      lastSyncAt: at.toISOString(),
      outboxDepth: 2, // the two logins clocked in
      mustSyncBefore: new Date(at.getTime() + 24 * HOUR).toISOString(),
      locked: false,
      lockReason: null,
      rejections: 0,
      orphans: 0,
    })
    await request(http).get('/pos/v1/hub/status').expect(401)
  })

  it('locks new sales 24 h + 1 s after the last sync, while open bills still finalize and print', async () => {
    const post = (path: string, body?: object) => request(http).post(path).set(cashier).send(body)
    const shift = (await post('/pos/v1/shifts', { outletId: f.outletId, floatMinor: 0 }).expect(201)).body as { id: string }
    const order = (await post(`/pos/v1/outlets/${f.outletId}/tables/${f.tableId}/order`).expect(200)).body as { id: string }
    await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: 1 }).expect(201)
    const bill = (await post(`/pos/v1/orders/${order.id}/bill`).expect(201)).body as { id: string; subtotalMinor: number }

    now = new Date((await lastSync()).getTime() + 24 * HOUR + 1000)
    expect((await request(http).get('/pos/v1/hub/status').set(cashier).expect(200)).body).toMatchObject({ locked: true, lockReason: 'offline_limit' })
    for (const res of [
      await post(`/pos/v1/outlets/${f.outletId}/counter-orders`),
      await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: 1 }),
      await post(`/pos/v1/orders/${order.id}/combos`, { comboId: f.comboId, quantity: 1, selections: [{ optionId: f.comboOptionId }] }),
    ]) {
      expect(res.status).toBe(423)
      expect(res.body).toMatchObject({ error: { code: 'offline_locked' } })
      expect((res.body as { error: { message: string } }).error.message).toMatch(/offline too long/)
    }
    // A new table order too - and an anonymous caller still hears 401 first.
    await request(http).post(`/pos/v1/outlets/${f.outletId}/tables/${f.tableId}/order`).set(cashier).expect(423)
    await request(http).post(`/pos/v1/outlets/${f.outletId}/counter-orders`).expect(401)

    const due = BigInt(bill.subtotalMinor)
    const total = Number(due + computeTax({ country: 'IN', taxProfile: '', compositionScheme: false, gstRegistered: true, subtotalMinor: due }).taxMinor)
    await post(`/pos/v1/bills/${bill.id}/finalize`, { tenders: [{ method: 'cash', amountMinor: total }] }).expect(200)
    await post(`/pos/v1/bills/${bill.id}/print`).expect(201)
    await request(http).get(`/pos/v1/bills/${bill.id}`).set(cashier).expect(200)
    await post(`/pos/v1/shifts/${shift.id}/close`, { countedMinor: total }).expect(200)
  })

  it('a successful sync clears the lock', async () => {
    await applyPull(pg, { changes: [], nextCursor: '1', hasMore: false, serverTime: new Date().toISOString() })
    now = new Date((await lastSync()).getTime() + 1000)
    expect((await request(http).get('/pos/v1/hub/status').set(cashier).expect(200)).body).toMatchObject({ locked: false, lockReason: null })
    await request(http).post(`/pos/v1/outlets/${f.outletId}/counter-orders`).set(cashier).expect(201)
  })

  it('needs settle_bills to list and acknowledge sync issues', async () => {
    const opId = uuidv7()
    await addRejection(opId)
    expect((await request(http).get('/pos/v1/hub/status').set(waiter).expect(200)).body).toMatchObject({ rejections: 1 })
    await request(http).get('/pos/v1/hub/rejections').set(waiter).expect(403)
    await request(http).post(`/pos/v1/hub/rejections/${opId}/acknowledge`).set(waiter).expect(403)
    const res = await request(http).get('/pos/v1/hub/rejections').set(cashier).expect(200)
    const { items } = res.body as { items: { at: string }[] }
    expect(items).toMatchObject([{ opId, type: 'order.create', code: 'outlet_closed', message: 'Outlet is closed', source: 'cloud' }])
    expect(Date.parse(items[0].at)).not.toBeNaN()
    await request(http).post(`/pos/v1/hub/rejections/${uuidv7()}/acknowledge`).set(cashier).expect(404)
  })

  it('forwards an acknowledgement to the cloud when online', async () => {
    const opId = uuidv7()
    await addRejection(opId)
    worker!.online = true
    await request(http).post(`/pos/v1/hub/rejections/${opId}/acknowledge`).set(cashier).expect(204)
    expect(acked).toContain(opId)
    expect((await pg.query('SELECT 1 FROM hub_rejections WHERE op_id = $1 AND acknowledged AND NOT ack_pending', [opId])).rows).toHaveLength(1)
    const listed = (await request(http).get('/pos/v1/hub/rejections').set(cashier).expect(200)).body as { items: { opId: string }[] }
    expect(listed.items.map((item) => item.opId)).not.toContain(opId)
  })

  it('queues an acknowledgement while offline and sends it on the next tick', async () => {
    const opId = uuidv7()
    await addRejection(opId)
    worker!.online = false
    await request(http).post(`/pos/v1/hub/rejections/${opId}/acknowledge`).set(cashier).expect(204)
    expect(acked).not.toContain(opId)
    expect((await pg.query('SELECT 1 FROM hub_rejections WHERE op_id = $1 AND ack_pending', [opId])).rows).toHaveLength(1)
    await worker!.forwardAcks()
    expect(acked).toContain(opId)
  })

  it('refuses every write once the device is revoked', async () => {
    await pg.query(`UPDATE hub_meta SET locked = true, lock_reason = 'revoked'`)
    expect((await request(http).get('/pos/v1/hub/status').set(cashier).expect(200)).body).toMatchObject({ locked: true, lockReason: 'revoked' })
    const shift = await request(http).post('/pos/v1/shifts').set(cashier).send({ outletId: f.outletId, floatMinor: 0 })
    expect(shift.status).toBe(423)
    expect(shift.body).toMatchObject({ error: { code: 'device_revoked' } })
    await request(http).post('/pos/v1/clock/out').set(cashier).expect(423)
    await request(http).get(`/pos/v1/outlets/${f.outletId}/orders`).set(cashier).expect(200)
    await request(http).post('/pos/v1/auth/logout').set(cashier).expect((res) => expect(res.status).toBeLessThan(300))
  })
})
