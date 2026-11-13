// Offline hub test matrix (#310, HUB-BUILD-PLAN T1, SYNC-DESIGN §12.6): the
// cloud Nest app (Postgres) on an ephemeral port and the hub app (PGlite) in
// this process, the sync worker between them over signed HTTP. Each case runs
// on the state the one before left, and ends by checking the cloud holds
// exactly the hub's sales. Manual items (hub down / both down, real tills)
// stay on restiq-desktop's HUB-TEST-CHECKLIST.md.
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { KeyObject } from 'node:crypto'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { basename, join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setPrismaClient, type PrismaClient } from '../src/db/client'
import { createHubApp } from '../src/hub/hub.module'
import { compactJournal, readAck, readJournal } from '../src/hub/journal'
import { HubContext } from '../src/hub/lock.guard'
import { readMeta } from '../src/hub/meta'
import { outboxDepth, readOutbox, readUnacked } from '../src/hub/outbox'
import { openOrRebuild, reconcile } from '../src/hub/recovery'
import { SyncWorker } from '../src/hub/sync-worker'
import { deleteCloudTenant, enrolHub, hubRows as rowsOf, settle, startCloud, type Cloud, type Row } from './hub-cloud'
import { HUB_PIN, MANAGER_PIN, ringUpSale, seedSaleFixture, seedTenantRows, type SaleFixture } from './hub-seed'

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations')
type Http = Parameters<typeof request>[0]
type Auth = { Authorization: string }

// Every synced sales row, as text so Postgres and PGlite compare equal.
const SALES = {
  orders: `SELECT id, status::text, table_id::text FROM orders WHERE tenant_id = $1::uuid ORDER BY id`,
  lines: `SELECT id, order_id::text, item_id::text, combo_id::text, quantity, unit_price_minor::text, voided_at IS NOT NULL AS voided FROM order_lines WHERE tenant_id = $1::uuid ORDER BY id`,
  modifiers: `SELECT order_line_id::text, modifier_id::text, count(*)::int AS n FROM order_line_modifiers WHERE tenant_id = $1::uuid GROUP BY 1, 2 ORDER BY 1, 2`,
  bills: `SELECT id, order_id::text, subtotal_minor::text, tax_minor::text, discount_minor::text, status::text FROM bills WHERE tenant_id = $1::uuid ORDER BY id`,
  tenders: `SELECT id, bill_id::text, method::text, amount_minor::text FROM tenders WHERE tenant_id = $1::uuid ORDER BY id`,
  tickets: `SELECT order_id::text, status::text, count(*)::int AS n FROM tickets WHERE tenant_id = $1::uuid GROUP BY 1, 2 ORDER BY 1, 2`,
}

describe('hub offline test matrix (e2e)', () => {
  let c: Cloud
  let cloud: PrismaClient
  let hub: PGlite
  let hubApp: INestApplication
  let http: Http
  let worker: SyncWorker
  let device: { deviceId: string; key: KeyObject }
  let f: SaleFixture
  let till: Auth
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-matrix-'))

  const hubRows = (sql: string, params: unknown[] = []) => rowsOf(hub, sql, params)
  /** A restarted worker: a fresh instance on the same store, as after a hub process restart. */
  const newWorker = () => new SyncWorker({ pg: hub, dataDir, cloudUrl: c.url, ...device, appVersion: 'hub-matrix' })
  const post = (auth: Auth, path: string, body?: object) => request(http).post(path).set(auth).send(body)

  async function login(pin: string): Promise<Auth> {
    const res = await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin }).expect(200)
    return { Authorization: `Bearer ${(res.body as { token: string }).token}` }
  }

  async function status(): Promise<{ online: boolean; outboxDepth: number; locked: boolean; lockReason: string | null }> {
    return (await request(http).get('/pos/v1/hub/status').set(till).expect(200)).body as Awaited<ReturnType<typeof status>>
  }

  /** The cloud holds exactly the hub's sales rows, and every op was applied once. */
  async function expectCloudMatchesHub(): Promise<void> {
    for (const sql of Object.values(SALES)) expect(await cloud.$queryRawUnsafe<Row[]>(sql, f.tenantId)).toEqual(await hubRows(sql, [f.tenantId]))
    const ops = await readOutbox(hub)
    expect(ops.filter((op) => op.seq > readAck(dataDir))).toEqual([])
    expect(await hubRows(`SELECT result->>'status' AS status, count(*)::int AS n FROM hub_outbox WHERE result->>'status' NOT IN ('accepted', 'duplicate') GROUP BY 1`)).toEqual([])
    expect(await cloud.appliedOp.count({ where: { deviceId: device.deviceId } })).toBe(ops.length)
  }

  /** One sale on a till: dosa with ghee, coffee; every 5th a combo, every 10th sent to the kitchen and the coffee voided with a manager PIN; paid cash. */
  async function sale(auth: Auth, i: number, tableId?: string): Promise<void> {
    const order = (
      tableId
        ? await post(auth, `/pos/v1/outlets/${f.outletId}/tables/${tableId}/order`).expect(200)
        : await post(auth, `/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)
    ).body as { id: string }
    await post(auth, `/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: 1 + (i % 3), modifierIds: [f.gheeId] }).expect(201)
    const coffee = ((await post(auth, `/pos/v1/orders/${order.id}/lines`, { itemId: f.coffeeId, quantity: 1 }).expect(201)).body as { lines: { id: string; itemId: string | null }[] }).lines.find(
      (l) => l.itemId === f.coffeeId,
    )!
    if (i % 5 === 0) await post(auth, `/pos/v1/orders/${order.id}/combos`, { comboId: f.comboId, quantity: 1, selections: [{ optionId: f.comboOptionId, modifierIds: [] }] }).expect(201)
    if (i % 10 === 0) {
      await request(http).patch(`/pos/v1/orders/${order.id}/status`).set(auth).send({ status: 'sent' }).expect(200)
      await post(auth, `/pos/v1/orders/${order.id}/lines/${coffee.id}/void`, { managerPin: MANAGER_PIN, reason: 'Wrong item' }).expect(200)
    }
    const bill = (await post(auth, `/pos/v1/orders/${order.id}/bill`).expect(201)).body as { id: string; totalMinor: number }
    await post(auth, `/pos/v1/bills/${bill.id}/finalize`, { tenders: [{ method: 'cash', amountMinor: bill.totalMinor }] }).expect(200)
  }

  /** hub-main's startup on dataDir: open (or rebuild) the store, compact the journal, build the app, reconcile, listen; a fresh worker. */
  async function startHub(): Promise<void> {
    const store = await openOrRebuild(dataDir, MIGRATIONS)
    hub = store.pg
    compactJournal(dataDir)
    setPrismaClient(store.prisma)
    worker = newWorker()
    // No kick per write: each case says when the worker ticks.
    hubApp = await createHubApp(hub, dataDir, undefined, new HubContext(hub, undefined, () => worker))
    await reconcile(hubApp, hub, dataDir)
    // Listening, as on a till: concurrent supertest calls on an unbound server share (and close) one ephemeral listener.
    await hubApp.listen(0, '127.0.0.1')
    http = await hubApp.getUrl()
  }

  async function stopHub(): Promise<void> {
    await worker?.stop()
    await hubApp?.close()
    await hub?.close()
  }

  beforeAll(async () => {
    c = await startCloud()
    cloud = c.prisma
    f = await seedSaleFixture(cloud, await seedTenantRows(cloud, 'Hub Matrix'))
    device = await enrolHub(cloud, f)
    await startHub()
    await settle(cloud, f.tenantId)
    await worker.sync()
    expect(worker.lastError).toBeNull()
  }, 60_000)

  afterAll(async () => {
    await stopHub()
    await c?.app.close()
    for (const name of readdirSync(tmpdir()).filter((n) => n.startsWith(basename(dataDir)))) rmSync(join(tmpdir(), name), { recursive: true, force: true })
    if (f) await deleteCloudTenant(cloud, f.tenantId, device?.deviceId)
    await cloud?.$disconnect()
  })

  it('online: a sale on the hub is an identical bill in the cloud after one worker tick', async () => {
    const { billId } = await ringUpSale(http, f)
    await worker.sync()
    expect(worker.lastError).toBeNull()
    expect(await outboxDepth(hub)).toBe(0)
    expect(await cloud.bill.findUniqueOrThrow({ where: { id: billId } })).toMatchObject({ status: 'finalized' })
    await expectCloudMatchesHub()
  }, 30_000)

  it('offline from the internet: 50 sales queue in the outbox, then drain on reconnect with equal totals and no duplicates', async () => {
    till = await login(HUB_PIN)
    await post(till, '/pos/v1/shifts', { outletId: f.outletId, floatMinor: 50000 }).expect(201)
    await worker.sync()
    await c.down()
    await worker.sync()
    expect(worker.online).toBe(false)

    for (let i = 0; i < 50; i++) await sale(till, i, i % 2 === 0 ? f.tableId : undefined)
    const offline = await status()
    expect(offline).toMatchObject({ online: false, locked: false })
    expect(offline.outboxDepth).toBeGreaterThanOrEqual(50)
    expect(await cloud.bill.count({ where: { tenantId: f.tenantId } })).toBe(1)

    await c.up()
    await worker.sync()
    expect(worker.lastError).toBeNull()
    expect(await status()).toMatchObject({ online: true, outboxDepth: 0 })
    expect(await cloud.bill.count({ where: { tenantId: f.tenantId, status: 'finalized' } })).toBe(51)
    const totals = `SELECT count(*)::int AS bills, sum(subtotal_minor + tax_minor)::text AS total FROM bills WHERE tenant_id = $1::uuid AND status = 'finalized'`
    expect(await cloud.$queryRawUnsafe<Row[]>(totals, f.tenantId)).toEqual(await hubRows(totals, [f.tenantId]))
    await expectCloudMatchesHub()
  }, 60_000)

  it('mid-push crash: the cloud committed but the ack was never saved; a restarted worker re-pushes, gets duplicate, counts nothing twice', async () => {
    await sale(till, 1)
    const pending = (await readUnacked(hub, 1000)).map((op) => op.opId)
    expect(pending.length).toBeGreaterThan(0)
    const realFetch = globalThis.fetch
    const crash = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const res = await realFetch(input, init)
      if (input instanceof URL && input.pathname === '/sync/v1/push') throw new Error('hub died before saving the ack')
      return res
    })
    try {
      await worker.sync()
    } finally {
      crash.mockRestore()
    }
    expect(worker.lastError).toContain('hub died')
    expect((await readUnacked(hub, 1000)).map((op) => op.opId)).toEqual(pending)
    const bills = await cloud.bill.count({ where: { tenantId: f.tenantId } })
    expect(bills).toBe(52) // the cloud did commit the batch

    await worker.stop()
    worker = newWorker()
    await worker.sync()
    expect(worker.lastError).toBeNull()
    const results = await hubRows(`SELECT DISTINCT result->>'status' AS status FROM hub_outbox WHERE op_id = ANY($1::uuid[])`, [pending])
    expect(results).toEqual([{ status: 'duplicate' }])
    expect(await cloud.bill.count({ where: { tenantId: f.tenantId } })).toBe(bills)
    expect(await outboxDepth(hub)).toBe(0)
    await expectCloudMatchesHub()
  })

  it('two tills and a kitchen screen at once: no lost lines, every ticket on the KDS, the cloud matches after sync', async () => {
    const { floorId } = await cloud.diningTable.findUniqueOrThrow({ where: { id: f.tableId } })
    const labels = Array.from({ length: 40 }, (_, i) => `M${i}`)
    await cloud.diningTable.createMany({ data: labels.map((label, i) => ({ tenantId: f.tenantId, floorId, label, x: i, y: 0, width: 1, height: 1, shape: 'square' as const, seatCapacity: 2 })) })
    const tables = await cloud.diningTable.findMany({ where: { tenantId: f.tenantId, label: { in: labels } }, orderBy: { label: 'asc' } })
    await settle(cloud, f.tenantId)
    await worker.sync()
    const kds = await login(HUB_PIN)
    const tills = [till, await login(MANAGER_PIN)]
    const orderIds: string[] = []

    const ring = async (auth: Auth, mine: typeof tables) => {
      for (const table of mine) {
        const order = (await post(auth, `/pos/v1/outlets/${f.outletId}/tables/${table.id}/order`).expect(200)).body as { id: string }
        orderIds.push(order.id)
        await post(auth, `/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: 1, modifierIds: [f.gheeId] }).expect(201)
        await post(auth, `/pos/v1/orders/${order.id}/lines`, { itemId: f.coffeeId, quantity: 2 }).expect(201)
        await request(http).patch(`/pos/v1/orders/${order.id}/status`).set(auth).send({ status: 'sent' }).expect(200)
      }
    }
    const seen = new Map<string, number>() // ticket id -> lines on it
    let ringing = true
    const kitchen = async () => {
      for (;;) {
        const done = !ringing
        const queue = (await request(http).get(`/kitchen/v1/outlets/${f.outletId}/stations/${f.stationId}/queue`).set(kds).expect(200)).body as { id: string; orderId: string; lines: unknown[] }[]
        for (const ticket of queue.filter((t) => orderIds.includes(t.orderId))) {
          seen.set(ticket.id, ticket.lines.length)
          await post(kds, `/kitchen/v1/tickets/${ticket.id}/bump`).expect(200)
        }
        if (done && queue.every((t) => !orderIds.includes(t.orderId))) return
        await sleep(50) // a KDS polls; it doesn't spin
      }
    }
    const tillsDone = Promise.all([ring(tills[0], tables.slice(0, 20)), ring(tills[1], tables.slice(20))]).finally(() => (ringing = false))
    await Promise.all([tillsDone, kitchen()])

    expect(orderIds).toHaveLength(40)
    expect(await hubRows(`SELECT count(*)::int AS n FROM order_lines WHERE order_id = ANY($1::uuid[])`, [orderIds])).toEqual([{ n: 80 }])
    expect(seen.size).toBe(40)
    expect([...seen.values()].every((n) => n === 2)).toBe(true)
    expect(await hubRows(`SELECT DISTINCT status::text FROM tickets WHERE order_id = ANY($1::uuid[])`, [orderIds])).toEqual([{ status: 'bumped' }])

    await worker.sync()
    expect(worker.lastError).toBeNull()
    expect(await outboxDepth(hub)).toBe(0)
    expect(await cloud.orderLine.count({ where: { orderId: { in: orderIds } } })).toBe(80)
    await expectCloudMatchesHub()
  }, 60_000)

  it('O1 lock: past maxOfflineHours offline, new orders get 423 and open bills still finalize; a sync clears the lock', async () => {
    const open = (await post(till, `/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)).body as { id: string }
    await post(till, `/pos/v1/orders/${open.id}/lines`, { itemId: f.itemId, quantity: 1 }).expect(201)
    await c.down()
    await worker.sync()
    // ponytail: hours pass by ageing the last sync - the guard's clock and PGlite's now() then both stay real.
    const { maxOfflineHours } = (await readMeta(hub))!.policy
    await hub.query('UPDATE hub_meta SET last_sync_at = now() - make_interval(hours => $1 + 1)', [maxOfflineHours])

    expect(await status()).toMatchObject({ online: false, locked: true, lockReason: 'offline_limit' })
    expect((await post(till, `/pos/v1/outlets/${f.outletId}/counter-orders`).expect(423)).body).toMatchObject({ error: { code: 'offline_locked' } })
    await post(till, `/pos/v1/orders/${open.id}/lines`, { itemId: f.itemId, quantity: 1 }).expect(423)
    const bill = (await post(till, `/pos/v1/orders/${open.id}/bill`).expect(201)).body as { id: string; totalMinor: number }
    await post(till, `/pos/v1/bills/${bill.id}/finalize`, { tenders: [{ method: 'cash', amountMinor: bill.totalMinor }] }).expect(200)

    await c.up()
    await worker.sync()
    expect(await status()).toMatchObject({ online: true, locked: false, lockReason: null })
    await post(till, `/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)
    await worker.sync()
    await expectCloudMatchesHub()
  })

  it('recovery after a crash: PGlite will not open, the hub rebuilds from bootstrap.json and the journal, then drains with no duplicates', async () => {
    await c.down()
    await worker.sync()
    for (let i = 0; i < 3; i++) await sale(till, i)
    const pending = await readUnacked(hub, 1000)
    const orderIds = (await hubRows(`SELECT id FROM orders WHERE created_at >= $1`, [pending[0].at])).map((r) => String(r.id))
    expect(orderIds).toHaveLength(3)
    const ofOrders = {
      lines: `SELECT id, item_id::text, combo_id::text, quantity, unit_price_minor::text, voided_at IS NOT NULL AS voided FROM order_lines WHERE order_id = ANY($1::uuid[]) ORDER BY id`,
      bills: `SELECT id, subtotal_minor::text, tax_minor::text, status::text FROM bills WHERE order_id = ANY($1::uuid[]) ORDER BY id`,
      tenders: `SELECT t.id, t.amount_minor::text FROM tenders t JOIN bills b ON b.id = t.bill_id WHERE b.order_id = ANY($1::uuid[]) ORDER BY t.id`,
    }
    const before: Row[][] = []
    for (const sql of Object.values(ofOrders)) before.push(await hubRows(sql, [orderIds]))
    const cloudBills = await cloud.bill.count({ where: { tenantId: f.tenantId } })

    // As a kill -9 can leave it: pg_control is garbage, PGlite will not open.
    await stopHub()
    writeFileSync(join(dataDir, 'global', 'pg_control'), Buffer.alloc(8192, 7))
    await startHub()
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith(`${basename(dataDir)}.broken-`))).toHaveLength(1)
    expect(await readOutbox(hub)).toEqual(readJournal(dataDir))
    expect(await readUnacked(hub, 1000)).toEqual(pending)
    const after: Row[][] = []
    for (const sql of Object.values(ofOrders)) after.push(await hubRows(sql, [orderIds]))
    expect(after).toEqual(before)

    await c.up()
    till = await login(HUB_PIN)
    await worker.sync()
    expect(worker.lastError).toBeNull()
    expect(await outboxDepth(hub)).toBe(0)
    expect(await hubRows(`SELECT DISTINCT result->>'status' AS status FROM hub_outbox WHERE op_id = ANY($1::uuid[])`, [pending.map((op) => op.opId)])).toEqual([{ status: 'accepted' }])
    expect(await cloud.bill.count({ where: { tenantId: f.tenantId } })).toBe(cloudBills + 3)
    for (const sql of Object.values(ofOrders)) expect(await cloud.$queryRawUnsafe<Row[]>(sql, orderIds)).toEqual(await hubRows(sql, [orderIds]))
  }, 60_000)

  it('revoked while offline sales are pending: the hub locks and keeps every unsynced op in the outbox and journal', async () => {
    // The rebuild above restored bootstrap.json, which predates case 2's shift (acked, so not replayed): see KNOWN_ISSUES.
    await post(till, '/pos/v1/shifts', { outletId: f.outletId, floatMinor: 50000 }).expect(201)
    await c.down()
    await worker.sync()
    for (let i = 0; i < 3; i++) await sale(till, i)
    const pending = await readUnacked(hub, 1000)
    expect(pending.length).toBeGreaterThan(0)
    const ack = readAck(dataDir)

    await cloud.device.update({ where: { id: device.deviceId }, data: { status: 'revoked', revokedAt: new Date() } })
    await c.up()
    await worker.sync()
    expect(worker.isStopped).toBe(true)
    expect(await readMeta(hub)).toMatchObject({ locked: true, lockReason: 'revoked' })
    expect(await readUnacked(hub, 1000)).toEqual(pending)
    expect(readAck(dataDir)).toBe(ack)
    const journal = new Set(readJournal(dataDir).map((op) => op.opId))
    expect(pending.every((op) => journal.has(op.opId))).toBe(true)
    expect(await cloud.appliedOp.count({ where: { opId: { in: pending.map((op) => op.opId) } } })).toBe(0)
    expect((await post(till, `/pos/v1/outlets/${f.outletId}/counter-orders`).expect(423)).body).toMatchObject({ error: { code: 'device_revoked' } })
    await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin: HUB_PIN }).expect(401)
  })
})
