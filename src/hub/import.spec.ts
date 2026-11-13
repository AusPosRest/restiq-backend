// Hub bootstrap import and pull applier (#296) on in-memory PGlite, no
// Postgres: the payload is built from a second seeded PGlite store plus a
// hand-added row, imported, then changed by hand-built pull pages.
import type { PGlite } from '@electric-sql/pglite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedHubTenant, type HubSeed } from '../../test/hub-seed'
import { CLOUD_TABLES } from '../pos/sync/sync.service'
import { uuidv7 } from '../platform'
import { applyPull, importBootstrap, type BootstrapPayload, type PullPage } from './import'
import { readMeta } from './meta'
import { APP_ROLE, openStore } from './store'

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations')
type Row = Record<string, unknown>

async function asSuperuser<T>(pg: PGlite, fn: () => Promise<T>): Promise<T> {
  await pg.exec('RESET ROLE')
  try {
    return await fn()
  } finally {
    await pg.exec(`SET ROLE ${APP_ROLE}`)
  }
}

const rowsOf = (pg: PGlite, table: string) => asSuperuser(pg, async () => (await pg.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`)).rows.map((r) => r.row))

describe('hub bootstrap import and pull', () => {
  let cloud: PGlite
  let hub: PGlite
  let seed: HubSeed
  let payload: BootstrapPayload
  let extraCategoryId: string
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-import-'))

  beforeAll(async () => {
    const source = await openStore(undefined, MIGRATIONS)
    cloud = source.pg
    seed = await seedHubTenant(cloud, source.prisma, 'Import')
    const data: Record<string, Row[]> = {}
    for (const table of CLOUD_TABLES) data[table] = await rowsOf(cloud, table)
    // Hand-built: a second category the cloud store never had.
    extraCategoryId = uuidv7()
    data.menu_categories.push({ ...data.menu_categories[0], id: extraCategoryId, name: 'Drinks' })
    payload = { cursor: '7', outletId: seed.outletId, policy: { maxOfflineHours: 24, syncIntervalSeconds: 30 }, permissions: { Cashier: ['settle_bills'] }, data }
    ;({ pg: hub } = await openStore(undefined, MIGRATIONS))
  }, 60_000)

  afterAll(async () => {
    await cloud?.close()
    await hub?.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function counts(): Promise<Record<string, number>> {
    return Object.fromEntries(await Promise.all(CLOUD_TABLES.map(async (t) => [t, (await rowsOf(hub, t)).length] as const)))
  }
  const expected = () => Object.fromEntries(CLOUD_TABLES.map((t) => [t, payload.data[t].length]))

  it('imports every table, records hub_meta, keeps bootstrap.json and hands the connection back to the app role', async () => {
    await importBootstrap(hub, payload, dataDir)
    expect(await counts()).toEqual(expected())
    expect(await rowsOf(hub, 'menu_items')).toEqual(payload.data.menu_items)

    const meta = await readMeta(hub)
    expect(meta).toMatchObject({ tenantId: seed.tenantId, outletId: seed.outletId, deviceId: null, cursor: '7', policy: payload.policy, permissions: payload.permissions, locked: false })
    expect(meta!.mustSyncBefore!.getTime() - meta!.lastSyncAt!.getTime()).toBe(24 * 3600 * 1000)

    expect(JSON.parse(readFileSync(join(dataDir, 'bootstrap.json'), 'utf8'))).toEqual(payload)
    expect(existsSync(join(dataDir, 'bootstrap.json.tmp'))).toBe(false)
    expect((await hub.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u).toBe(APP_ROLE)
  })

  it('applies a pull page in version order, deletes, skips unknown tables and saves the cursor', async () => {
    const price = payload.data.item_prices[0]
    const page: PullPage = {
      changes: [
        { entity: 'item_prices', id: String(price.id), action: 'upsert', version: 12, data: { ...price, price_minor: 15000 } },
        { entity: 'item_prices', id: String(price.id), action: 'upsert', version: 11, data: { ...price, price_minor: 13000 } },
        { entity: 'menu_categories', id: extraCategoryId, action: 'delete', version: 9 },
        { entity: 'orders', id: uuidv7(), action: 'upsert', version: 10, data: { id: 'not-applied' } },
      ],
      nextCursor: '12',
      hasMore: false,
      serverTime: new Date().toISOString(),
    }
    await applyPull(hub, page)
    expect((await rowsOf(hub, 'item_prices'))[0]).toMatchObject({ id: price.id, price_minor: 15000 })
    expect((await rowsOf(hub, 'menu_categories')).map((r) => r.id)).toEqual([payload.data.menu_categories[0].id])
    expect((await readMeta(hub))?.cursor).toBe('12')
  })

  it('re-imports the same bootstrap idempotently, back to the snapshot', async () => {
    await importBootstrap(hub, payload, dataDir)
    await importBootstrap(hub, payload, dataDir)
    expect(await counts()).toEqual(expected())
    expect((await rowsOf(hub, 'item_prices'))[0]).toMatchObject({ price_minor: 12000 })
    expect((await readMeta(hub))?.cursor).toBe('7')
  })

  it('rolls a failed import back whole and keeps the app role', async () => {
    const broken = { ...payload, cursor: '99', data: { ...payload.data, menu_items: [{ ...payload.data.menu_items[0], id: 'not-a-uuid' }] } }
    await expect(importBootstrap(hub, broken, dataDir)).rejects.toThrow()
    expect((await readMeta(hub))?.cursor).toBe('7')
    expect(await counts()).toEqual(expected())
    expect(JSON.parse(readFileSync(join(dataDir, 'bootstrap.json'), 'utf8'))).toEqual(payload)
    expect((await hub.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u).toBe(APP_ROLE)
    await expect(importBootstrap(hub, { ...payload, data: { ...payload.data, tenants: [] } }, dataDir)).rejects.toThrow('no tenant row')
  })

  it('refuses a pull before any bootstrap', async () => {
    await expect(applyPull(cloud, { changes: [], nextCursor: '1', hasMore: false, serverTime: '' })).rejects.toThrow('not been bootstrapped')
  })
})
