// Hub sync worker (#304, HUB-BUILD-PLAN H4) against a real cloud: the cloud
// Nest app listens on an ephemeral port (Postgres), the hub app runs on
// in-memory PGlite in this process, and the worker talks to the cloud over
// signed HTTP exactly as on a till.
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setPrismaClient, type PrismaClient } from '../src/db/client'
import { createHubApp } from '../src/hub/hub.module'
import { readAck, readJournal } from '../src/hub/journal'
import { readMeta } from '../src/hub/meta'
import { insertOp, outboxDepth, readOutbox } from '../src/hub/outbox'
import { openStore } from '../src/hub/store'
import { SyncWorker } from '../src/hub/sync-worker'
import { deleteCloudTenant, enrolHub, hubRows as rowsOf, settle as settleOf, startCloud, type Cloud, type Row } from './hub-cloud'
import { HUB_PIN, ringUpSale, seedSaleFixture, seedTenantRows, type SaleFixture } from './hub-seed'

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations')
type Http = Parameters<typeof request>[0]

describe('hub sync worker against the cloud (e2e)', () => {
  let c: Cloud
  let cloud: PrismaClient
  let hub: PGlite
  let hubApp: INestApplication
  let http: Http
  let worker: SyncWorker
  let deviceId: string
  let f: SaleFixture
  let kicks = true
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-sync-e2e-'))

  const settle = () => settleOf(cloud, f.tenantId)
  const hubRows = (sql: string, params: unknown[] = []) => rowsOf(hub, sql, params)

  async function auth(): Promise<{ Authorization: string }> {
    const login = await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin: HUB_PIN }).expect(200)
    return { Authorization: `Bearer ${(login.body as { token: string }).token}` }
  }

  beforeAll(async () => {
    c = await startCloud()
    cloud = c.prisma
    f = await seedSaleFixture(cloud, await seedTenantRows(cloud, 'Hub Sync'))
    const device = await enrolHub(cloud, f)
    deviceId = device.deviceId

    const store = await openStore(undefined, MIGRATIONS)
    hub = store.pg
    setPrismaClient(store.prisma)
    worker = new SyncWorker({ pg: hub, dataDir, cloudUrl: c.url, deviceId, key: device.key, appVersion: 'hub-e2e' })
    hubApp = await createHubApp(hub, dataDir, () => kicks && worker.kick())
    await hubApp.init()
    http = hubApp.getHttpServer() as Http
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
    await hubApp?.close()
    await hub?.close()
    await c?.app.close()
    rmSync(dataDir, { recursive: true, force: true })
    if (f) await deleteCloudTenant(cloud, f.tenantId, deviceId)
    await cloud?.$disconnect()
  })

  it('bootstraps on its first run: hub_meta, the menu and staff arrive, and it reports online', async () => {
    await settle()
    expect(await readMeta(hub)).toBeUndefined()
    await worker.sync()
    expect(worker.lastError).toBeNull()
    expect(await readMeta(hub)).toMatchObject({ tenantId: f.tenantId, outletId: f.outletId, deviceId, online: true, locked: false })
    expect(await hubRows('SELECT id FROM menu_items WHERE id = $1', [f.itemId])).toHaveLength(1)
    const device = await cloud.device.findUniqueOrThrow({ where: { id: deviceId } })
    expect(device).toMatchObject({ appVersion: 'hub-e2e', outboxDepth: 0, recentRejectionCount: 0 })
    await auth() // the cloud's PIN hashes work on the hub
  })

  it('drains a sale rung up on the hub: every op accepted, the cloud bill equals the hub bill', async () => {
    const { billId } = await ringUpSale(http, f)
    await worker.sync()
    expect(worker.lastError).toBeNull()
    expect(await outboxDepth(hub)).toBe(0)
    const results = await hubRows(`SELECT result->>'status' AS status FROM hub_outbox`)
    expect(results.filter((r) => r.status !== 'accepted')).toEqual([])
    const ops = await readOutbox(hub)
    expect(readAck(dataDir)).toBe(ops.at(-1)!.seq)

    const [hubBill] = await hubRows(`SELECT subtotal_minor::text, tax_minor::text, discount_minor::text, status::text FROM bills WHERE id = $1`, [billId])
    const cloudBill = await cloud.bill.findUniqueOrThrow({ where: { id: billId } })
    expect({
      subtotal_minor: String(cloudBill.subtotalMinor),
      tax_minor: String(cloudBill.taxMinor),
      discount_minor: String(cloudBill.discountMinor),
      status: cloudBill.status,
    }).toEqual(hubBill)
    const tenders = `SELECT id, amount_minor::text FROM tenders WHERE bill_id = $1::uuid ORDER BY id`
    expect(await cloud.$queryRawUnsafe<Row[]>(tenders, billId)).toEqual(await hubRows(tenders, [billId]))
  }, 60_000)

  it('re-pushes an op whose ack was lost: the cloud answers duplicate and counts nothing twice', async () => {
    const [finalize] = await hubRows(`SELECT seq::int FROM hub_outbox WHERE type = 'bill.finalize'`)
    const tendersBefore = await cloud.tender.count({ where: { tenantId: f.tenantId } })
    const appliedBefore = await cloud.appliedOp.count({ where: { deviceId } })
    await hub.query('UPDATE hub_outbox SET acked_at = NULL, result = NULL WHERE seq = $1', [finalize.seq])
    await worker.sync()
    const [row] = await hubRows(`SELECT result->>'status' AS status, acked_at IS NOT NULL AS acked FROM hub_outbox WHERE seq = $1`, [finalize.seq])
    expect(row).toEqual({ status: 'duplicate', acked: true })
    expect(await cloud.tender.count({ where: { tenantId: f.tenantId } })).toBe(tendersBefore)
    expect(await cloud.appliedOp.count({ where: { deviceId } })).toBe(appliedBefore)
  })

  let openOrderId: string

  it('stops at a seq gap and keeps every op; the lost op from the journal then drains', async () => {
    kicks = false
    const headers = await auth()
    const post = (path: string, body?: object) => request(http).post(path).set(headers).send(body)
    const before = (await readOutbox(hub)).length
    const order = (await post(`/pos/v1/outlets/${f.outletId}/tables/${f.tableId}/order`).expect(200)).body as { id: string }
    openOrderId = order.id
    await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: 1, modifierIds: [f.gheeId] }).expect(201)
    await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.coffeeId, quantity: 1 }).expect(201)
    const fresh = (await readOutbox(hub)).slice(before)
    expect(fresh.map((op) => op.type)).toEqual(['order.create', 'order.line.add', 'order.line.add'])
    const [, lost, after] = fresh
    await hub.query('DELETE FROM hub_outbox WHERE seq = $1', [lost.seq])

    await worker.sync()
    expect(worker.blockedAt).toEqual({ seq: after.seq, code: 'seq_gap' })
    expect(worker.lastError).toBeNull() // the rest of the tick (pull, heartbeat) still ran
    expect(await hubRows('SELECT seq::int, acked_at IS NOT NULL AS acked FROM hub_outbox WHERE seq >= $1 ORDER BY seq', [fresh[0].seq])).toEqual([
      { seq: fresh[0].seq, acked: true },
      { seq: after.seq, acked: false },
    ])
    expect(readAck(dataDir)).toBe(fresh[0].seq)
    expect(readJournal(dataDir).map((op) => op.opId)).toContain(lost.opId)
    expect(await cloud.orderLine.count({ where: { orderId: order.id } })).toBe(0)

    await insertOp(hub, readJournal(dataDir).find((op) => op.opId === lost.opId)!)
    await worker.sync()
    expect(worker.blockedAt).toBeNull()
    expect(await outboxDepth(hub)).toBe(0)
    expect(await cloud.orderLine.count({ where: { orderId: order.id } })).toBe(2)
    kicks = true
  })

  it('pulls a cloud menu price change onto the hub menu', async () => {
    await cloud.itemPrice.updateMany({ where: { itemId: f.itemId }, data: { priceMinor: 13300n } })
    await settle()
    await worker.sync()
    const menu = await request(http).get('/pos/v1/menu').set(await auth()).expect(200)
    expect((menu.body as { items: { id: string; priceMinor: number }[] }).items.find((i) => i.id === f.itemId)?.priceMinor).toBe(13300)
  })

  it('bootstraps again on cursor_expired, taking open sales (the outbox is empty) without doubling cloud-made rows', async () => {
    const modifiers = `SELECT m.modifier_id FROM order_line_modifiers m JOIN order_lines l ON l.id = m.order_line_id WHERE l.order_id = $1::uuid`
    expect(await hubRows(modifiers, [openOrderId])).toHaveLength(1)
    // As the 30-day prune leaves it: only the tenant's newest change is kept, newer than the hub's cursor.
    await cloud.itemPrice.updateMany({ where: { itemId: f.coffeeId }, data: { priceMinor: 4600n } })
    const newest = await cloud.syncChange.findFirstOrThrow({ where: { tenantId: f.tenantId }, orderBy: { id: 'desc' } })
    await cloud.syncChange.deleteMany({ where: { tenantId: f.tenantId, id: { lt: newest.id } } })
    await settle()
    expect(BigInt((await readMeta(hub))!.cursor)).toBeLessThan(newest.id)
    await worker.sync()
    expect(worker.lastError).toBeNull()
    expect((await readMeta(hub))!.cursor).toBe(String(newest.id))
    // The cloud's copy of the open order replaced the hub's: one ghee, under the cloud's row id.
    const cloudMods = await cloud.$queryRawUnsafe<Row[]>(`SELECT m.id FROM order_line_modifiers m JOIN order_lines l ON l.id = m.order_line_id WHERE l.order_id = $1::uuid`, openOrderId)
    expect(await hubRows(`SELECT m.id FROM order_line_modifiers m JOIN order_lines l ON l.id = m.order_line_id WHERE l.order_id = $1::uuid`, [openOrderId])).toEqual(cloudMods)
    expect(await hubRows('SELECT id FROM order_lines WHERE order_id = $1', [openOrderId])).toHaveLength(2)
    // The hub keeps selling on it.
    await request(http).post(`/pos/v1/orders/${openOrderId}/lines`).set(await auth()).send({ itemId: f.coffeeId, quantity: 1 }).expect(201)
    await worker.sync()
    expect(await outboxDepth(hub)).toBe(0)
  })

  it('backs off while the cloud is unreachable, then drains on reconnect', async () => {
    await c.down()
    worker.start() // the timer from here on: backoff while down
    await request(http).post(`/pos/v1/orders/${openOrderId}/lines`).set(await auth()).send({ itemId: f.itemId, quantity: 1 }).expect(201)
    await vi.waitFor(() => expect(worker.failures).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 50 })
    expect(worker.online).toBe(false)
    expect((await readMeta(hub))?.online).toBe(false)
    expect(await outboxDepth(hub)).toBeGreaterThan(0)

    await c.up()
    await vi.waitFor(async () => expect(await outboxDepth(hub)).toBe(0), { timeout: 15_000, interval: 100 })
    await vi.waitFor(() => expect(worker.online).toBe(true), { timeout: 5_000, interval: 50 })
    expect(worker.failures).toBe(0)
    expect(await cloud.orderLine.count({ where: { orderId: openOrderId } })).toBe(4)
  }, 30_000)

  it('locks and clears every staff PIN when the cloud says the device is revoked, then stops', async () => {
    await cloud.device.update({ where: { id: deviceId }, data: { status: 'revoked', revokedAt: new Date() } })
    await worker.sync()
    expect(worker.isStopped).toBe(true)
    expect(await readMeta(hub)).toMatchObject({ locked: true, lockReason: 'revoked', online: false })
    expect(await hubRows('SELECT id FROM staff_users WHERE pin_hash IS NOT NULL')).toEqual([])
    await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin: HUB_PIN }).expect(401)
  })
})
