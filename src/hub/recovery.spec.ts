// Hub startup recovery (#306, HUB-BUILD-PLAN H5) on PGlite data dirs: the
// PGlite spike's kill -9 test on the real hub, a rebuild after the database
// files are corrupted or lost, and journal ops missing from the outbox.
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { bootHub } from '../../test/hub-boot'
import { HUB_PIN, seedSaleFixture, seedTenantRows, type SaleFixture } from '../../test/hub-seed'
import { CLOUD_TABLES } from '../pos/sync/sync.service'
import { importBootstrap, writeDurably } from './import'
import { readJournal } from './journal'
import { readOutbox } from './outbox'
import { reconcile } from './recovery'
import { APP_ROLE, openStore } from './store'

const ROOT = join(__dirname, '..', '..')
const MIGRATIONS = join(ROOT, 'prisma', 'migrations')
const ROUNDS = 12
const dirs: string[] = []

/** A data dir as a bootstrapped hub leaves it: seeded store, hub_meta and bootstrap.json (built from the seeded cloud tables). */
async function seedDir(): Promise<{ dataDir: string; f: SaleFixture }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-recovery-'))
  dirs.push(dataDir)
  const { pg, prisma } = await openStore(dataDir, MIGRATIONS)
  await pg.exec('RESET ROLE')
  const f = await seedSaleFixture(prisma, await seedTenantRows(prisma, 'Recovery'))
  const data: Record<string, Record<string, unknown>[]> = {}
  for (const table of CLOUD_TABLES) data[table] = (await pg.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(t) AS row FROM "${table}" t`)).rows.map((r) => r.row)
  await pg.exec(`SET ROLE ${APP_ROLE}`)
  await importBootstrap(pg, { cursor: '0', outletId: f.outletId, policy: { maxOfflineHours: 24, syncIntervalSeconds: 15 }, permissions: {}, data }, dataDir)
  await pg.close()
  return { dataDir, f }
}

/** A read as PGlite's superuser, past RLS. */
async function rows<T>(pg: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE')
    return (await tx.query<T>(sql, params)).rows
  })
}

async function close(hub: { pg: PGlite; app: INestApplication }): Promise<void> {
  await hub.app.close()
  await hub.pg.close()
}

async function login(app: INestApplication, f: SaleFixture) {
  const http = app.getHttpServer() as Parameters<typeof request>[0]
  const token = ((await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin: HUB_PIN }).expect(200)).body as { token: string }).token
  return (path: string, body?: object) => request(http).post(path).set({ Authorization: `Bearer ${token}` }).send(body)
}

const BILLS = `SELECT b.id, b.status, b.subtotal_minor::text AS subtotal, b.tax_minor::text AS tax,
  (SELECT count(*)::int FROM tenders t WHERE t.bill_id = b.id) AS tenders FROM bills b ORDER BY b.id`

afterAll(() => {
  for (const dir of dirs) {
    for (const name of readdirSync(dirname(dir)).filter((n) => n.startsWith(`${basename(dir)}.broken-`))) rmSync(join(dirname(dir), name), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('hub startup recovery', () => {
  process.env.POS_JWT_SECRET = 'hub-sale-loop-secret'

  it(`keeps every sale through ${ROUNDS} kill -9s at random moments: ops journaled, nothing doubled, outbox = journal`, async () => {
    const { dataDir, f } = await seedDir()
    for (let round = 0; round < ROUNDS; round++) {
      const child = spawn(process.execPath, ['-r', join(ROOT, 'test', 'swc-register.cjs'), join(ROOT, 'test', 'hub-sale-loop.ts'), dataDir, f.tenantId, f.outletId, f.itemId], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      const exited = new Promise((resolve) => child.once('exit', resolve))
      await new Promise<void>((resolve, reject) => {
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          if (out.includes('ready\n')) resolve()
        })
        void exited.then((code) => reject(new Error(`sale loop exited (${String(code)}) before ready: ${out}`)))
      })
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 400))
      child.kill('SIGKILL')
      await exited
    }

    const hub = await bootHub(dataDir, MIGRATIONS)
    const journal = readJournal(dataDir)
    expect(journal.map((op) => op.seq)).toEqual(journal.map((_, i) => i + 1))
    expect(new Set(journal.map((op) => op.opId)).size).toBe(journal.length)
    expect(await readOutbox(hub.pg)).toEqual(journal)

    const ids = (type: string, key: string) => journal.filter((op) => op.type === type).map((op) => op.payload[key] as string)
    const orphans = await rows<{ entity: string; id: string }>(hub.pg, 'SELECT entity, entity_id AS id FROM hub_orphans')
    const orphaned = (entity: string) => orphans.filter((o) => o.entity === entity).map((o) => o.id)
    const bills = await rows<{ id: string; status: string; tenders: number }>(hub.pg, BILLS)
    const finalized = bills.filter((b) => b.status === 'finalized')
    expect(finalized.length).toBeGreaterThan(ROUNDS) // sales happened
    // Every finalized bill has its op in the journal - or, killed between the commit and the fsync, is an orphan.
    const finalizeOps = new Set(ids('bill.finalize', 'billId'))
    for (const bill of finalized) expect(finalizeOps.has(bill.id) || orphaned('bill_finalized').includes(bill.id), bill.id).toBe(true)
    expect(finalizeOps.size).toBeGreaterThanOrEqual(finalized.length - orphaned('bill_finalized').length)
    // Every journaled finalize is applied, once.
    for (const id of finalizeOps) expect(bills.find((b) => b.id === id)).toMatchObject({ status: 'finalized', tenders: 1 })
    expect(finalized.every((b) => b.tenders === 1)).toBe(true)
    // Nothing doubled, nothing lost: each row is an op's or an orphan.
    const count = async (table: string) => (await rows<{ n: number }>(hub.pg, `SELECT count(*)::int AS n FROM ${table}`))[0].n
    expect(await count('orders')).toBe(new Set(ids('order.create', 'orderId')).size + orphaned('order').length)
    expect(await count('order_lines')).toBe(new Set(ids('order.line.add', 'lineId')).size + orphaned('order_line').length)
    expect(bills.length).toBe(new Set(ids('bill.create', 'billId')).size + orphaned('bill').length)
    await close(hub)
  }, 60_000)

  it('rebuilds a corrupted or lost database from bootstrap.json and the journal, bill for bill', async () => {
    const { dataDir, f } = await seedDir()
    let hub = await bootHub(dataDir, MIGRATIONS)
    const post = await login(hub.app, f)
    await post('/pos/v1/shifts', { outletId: f.outletId, floatMinor: 50000 }).expect(201)
    for (let i = 0; i < 3; i++) {
      const order = (await post(`/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)).body as { id: string }
      await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: i + 1, modifierIds: [f.gheeId] }).expect(201)
      const bill = (await post(`/pos/v1/orders/${order.id}/bill`).expect(201)).body as { id: string; totalMinor: number }
      if (i < 2) await post(`/pos/v1/bills/${bill.id}/finalize`, { tenders: [{ method: 'cash', amountMinor: bill.totalMinor }] }).expect(200) // the last stays open
    }
    const before = await rows(hub.pg, BILLS)
    await close(hub)
    const broken = () => readdirSync(dirname(dataDir)).filter((n) => n.startsWith(`${basename(dataDir)}.broken-`))

    // 1. PGlite will not open: pg_control is garbage.
    writeFileSync(join(dataDir, 'global', 'pg_control'), Buffer.alloc(8192, 7))
    hub = await bootHub(dataDir, MIGRATIONS)
    expect(broken()).toHaveLength(1)
    expect(await rows(hub.pg, BILLS)).toEqual(before)
    expect(await readOutbox(hub.pg)).toEqual(readJournal(dataDir))
    expect(await rows(hub.pg, 'SELECT * FROM hub_orphans')).toEqual([])
    await close(hub)

    // 2. The database files are gone (PGlite opens an empty one): only the journal, ack and bootstrap.json are left.
    for (const name of readdirSync(dataDir)) if (!['outbox.log', 'outbox.ack', 'bootstrap.json'].includes(name)) rmSync(join(dataDir, name), { recursive: true })
    hub = await bootHub(dataDir, MIGRATIONS)
    expect(broken()).toHaveLength(2)
    expect(await rows(hub.pg, BILLS)).toEqual(before)
    // ...and it keeps selling on the next seq.
    const next = await login(hub.app, f)
    await next(`/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)
    const journal = readJournal(dataDir)
    expect(journal.map((op) => op.seq)).toEqual(journal.map((_, i) => i + 1))
    expect(await readOutbox(hub.pg)).toEqual(journal)
    await close(hub)
  }, 60_000)

  it('puts journal ops missing from the outbox back, replaying any the database lost, and records orphans', async () => {
    const { dataDir, f } = await seedDir()
    const hub = await bootHub(dataDir, MIGRATIONS)
    const post = await login(hub.app, f)
    const order = (await post(`/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)).body as { id: string }
    await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: 2 }).expect(201)
    const lineOp = readJournal(dataDir).at(-1)!
    expect(lineOp.type).toBe('order.line.add')
    const lines = () => rows<{ id: string; price: string }>(hub.pg, 'SELECT id, unit_price_minor::text AS price FROM order_lines WHERE order_id = $1', [order.id])
    const dropOp = () => hub.pg.query('DELETE FROM hub_outbox WHERE op_id = $1', [lineOp.opId])

    // Power cut after the journal fsync, before the outbox insert: the line is in the database.
    await dropOp()
    await reconcile(hub.app, hub.pg, dataDir)
    expect(await readOutbox(hub.pg)).toEqual(readJournal(dataDir))
    expect(await lines()).toEqual([{ id: lineOp.payload.lineId, price: '12000' }])

    // PGlite lost the line too (it cannot fsync): replayed with the op's own id and price.
    await dropOp()
    await rows(hub.pg, 'DELETE FROM order_lines WHERE id = $1', [lineOp.payload.lineId])
    await reconcile(hub.app, hub.pg, dataDir)
    expect(await readOutbox(hub.pg)).toEqual(readJournal(dataDir))
    expect(await lines()).toEqual([{ id: lineOp.payload.lineId, price: '12000' }])

    // No op anywhere (killed between the commit and the fsync): an orphan, once, and no op is made up.
    await dropOp()
    writeDurably(join(dataDir, 'outbox.log'), readJournal(dataDir).filter((op) => op.opId !== lineOp.opId).map((op) => `${JSON.stringify(op)}\n`).join(''))
    await reconcile(hub.app, hub.pg, dataDir)
    await reconcile(hub.app, hub.pg, dataDir)
    expect(await rows(hub.pg, 'SELECT entity, entity_id AS id FROM hub_orphans')).toEqual([{ entity: 'order_line', id: lineOp.payload.lineId }])
    expect(await readOutbox(hub.pg)).toEqual(readJournal(dataDir))
    expect(readJournal(dataDir).map((op) => op.type)).not.toContain('order.line.add')
    expect(existsSync(join(dataDir, 'bootstrap.json'))).toBe(true)
    await close(hub)
  }, 60_000)
})
