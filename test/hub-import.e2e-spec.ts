// Hub bootstrap import and pull (#296, HUB-BUILD-PLAN H2) against the real
// cloud: the cloud's own SyncService (Postgres) feeds an in-memory PGlite hub,
// and the hub's own Nest app serves what arrived.
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import * as argon2 from 'argon2'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrismaClient, setPrismaClient, type PrismaClient } from '../src/db/client'
import { createHubApp } from '../src/hub/hub.module'
import { applyPull, importBootstrap, type BootstrapPayload } from '../src/hub/import'
import { readMeta } from '../src/hub/meta'
import { APP_ROLE, openStore } from '../src/hub/store'
import { PrismaService, RegionRegistryService, uuidv7, type DevicePrincipal } from '../src/platform'
import { CLOUD_TABLES, SyncService } from '../src/pos'

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations')
type Row = Record<string, unknown>

describe('hub bootstrap import and pull from the cloud (e2e)', () => {
  let cloud: PrismaClient
  let sync: SyncService
  let hub: PGlite
  let app: INestApplication
  let http: Parameters<typeof request>[0]
  let device: DevicePrincipal
  let priceId: string
  let goneItemId: string
  let goneItemPriceId: string
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-e2e-'))

  // Changes become visible to pull once settled (30 s); age them.
  const settle = () => cloud.$executeRaw`UPDATE sync_changes SET changed_at = now() - interval '1 minute' WHERE tenant_id = ${device.tenantId}::uuid`

  async function hubRows(table: string): Promise<Row[]> {
    await hub.exec('RESET ROLE')
    try {
      return (await hub.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`)).rows.map((r) => r.row)
    } finally {
      await hub.exec(`SET ROLE ${APP_ROLE}`)
    }
  }

  async function menu(): Promise<{ id: string; priceMinor: number | null }[]> {
    const login = await request(http).post('/pos/v1/auth/login').send({ tenantId: device.tenantId, pin: '1234' }).expect(200)
    const res = await request(http).get('/pos/v1/menu').set('Authorization', `Bearer ${(login.body as { token: string }).token}`).expect(200)
    return (res.body as { items: { id: string; priceMinor: number | null }[] }).items
  }

  beforeAll(async () => {
    cloud = createPrismaClient()
    // The cloud's real SyncService on its own client; the shared client below is the hub's.
    sync = new SyncService(new RegionRegistryService({ client: cloud } as PrismaService))

    const tenantId = uuidv7()
    await cloud.tenant.create({
      data: {
        id: tenantId,
        name: 'Hub Import',
        registeredAddress: '1 Test Street',
        contactName: 'Test Contact',
        contactEmail: `${tenantId}@test.example`,
        contactPhone: '+91 90000 00000',
        country: 'IN',
        status: 'active',
        plan: 'standard',
        billingPeriod: 'monthly',
      },
    })
    const brand = await cloud.brand.create({ data: { tenantId, name: 'Hub Import' } })
    const outlet = await cloud.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
    // A second outlet: its rows must not reach this outlet's hub.
    const other = await cloud.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Koramangala', address: 'B2', type: 'dine_in', timezone: 'Asia/Kolkata' } })
    const floor = await cloud.floor.create({ data: { tenantId, outletId: outlet.id, name: 'Ground Floor' } })
    await cloud.diningTable.create({ data: { tenantId, floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 } })
    await cloud.station.create({ data: { tenantId, outletId: outlet.id, name: 'Grill', ageingThresholdMinutes: 10 } })
    await cloud.station.create({ data: { tenantId, outletId: other.id, name: 'Grill', ageingThresholdMinutes: 10 } })
    const category = await cloud.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await cloud.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Masala dosa', shortName: 'Dosa' } })
    priceId = (await cloud.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 10000n, currency: 'INR', channel: 'dine_in' } })).id
    const gone = await cloud.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Idli', shortName: 'Idli' } })
    goneItemId = gone.id
    goneItemPriceId = (await cloud.itemPrice.create({ data: { tenantId, itemId: gone.id, priceMinor: 6000n, currency: 'INR', channel: 'dine_in' } })).id
    const group = await cloud.modifierGroup.create({ data: { tenantId, name: 'Extras', minSelections: 0, maxSelections: 2 } })
    await cloud.modifier.create({ data: { tenantId, groupId: group.id, name: 'Ghee', priceMinor: 1500n, sortOrder: 0 } })
    await cloud.itemModifierGroup.create({ data: { tenantId, itemId: item.id, groupId: group.id, sortOrder: 0 } })
    const role = await cloud.role.create({ data: { tenantId, name: 'Cashier', isSystem: true, isManager: false } })
    await cloud.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Asha', pinHash: await argon2.hash('1234') } })
    const hubDevice = await cloud.device.create({
      data: { tenantId, outletId: outlet.id, label: 'Hub', type: 'pos', role: 'hub', hardwareKeyFingerprint: `hub-${uuidv7()}`, enrolledAt: new Date() },
    })
    device = { deviceId: hubDevice.id, tenantId, outletId: outlet.id, isHub: true }

    const store = await openStore(undefined, MIGRATIONS)
    hub = store.pg
    setPrismaClient(store.prisma)
    app = await createHubApp(hub, dataDir)
    await app.init()
    http = app.getHttpServer() as Parameters<typeof request>[0]
  }, 60_000)

  afterAll(async () => {
    await app?.close() // disconnects the hub's Prisma client
    await hub?.close()
    rmSync(dataDir, { recursive: true, force: true })
    if (device) {
      const where = { tenantId: device.tenantId }
      await cloud.device.deleteMany({ where })
      await cloud.clockEvent.deleteMany({ where })
      await cloud.staffUser.deleteMany({ where })
      await cloud.role.deleteMany({ where })
      await cloud.itemModifierGroup.deleteMany({ where })
      await cloud.modifier.deleteMany({ where })
      await cloud.modifierGroup.deleteMany({ where })
      await cloud.itemPrice.deleteMany({ where })
      await cloud.menuItem.deleteMany({ where })
      await cloud.menuCategory.deleteMany({ where })
      await cloud.station.deleteMany({ where })
      await cloud.diningTable.deleteMany({ where })
      await cloud.floor.deleteMany({ where })
      await cloud.outlet.deleteMany({ where })
      await cloud.brand.deleteMany({ where })
      await cloud.syncChange.deleteMany({ where })
      await cloud.auditEvent.deleteMany({ where })
      await cloud.tenant.deleteMany({ where: { id: device.tenantId } })
    }
    await cloud?.$disconnect()
  })

  let payload: BootstrapPayload

  it('imports the real bootstrap: every table has the same rows on the hub', async () => {
    await settle()
    payload = await sync.bootstrap(device)
    await importBootstrap(hub, payload, dataDir)

    const counts = async () => Object.fromEntries(await Promise.all(CLOUD_TABLES.map(async (t) => [t, (await hubRows(t)).length] as const)))
    expect(await counts()).toEqual(Object.fromEntries(CLOUD_TABLES.map((t) => [t, payload.data[t].length])))
    expect(payload.data.stations).toHaveLength(1)
    for (const table of CLOUD_TABLES) {
      const sent = [...payload.data[table]].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      expect(await hubRows(table), table).toEqual(sent)
    }
    expect(await readMeta(hub)).toMatchObject({ tenantId: device.tenantId, outletId: device.outletId, cursor: payload.cursor })

    const items = await menu()
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ priceMinor: 10000 }), expect.objectContaining({ id: goneItemId, priceMinor: 6000 })]))
  })

  it('pulls a cloud price change and a delete onto the hub', async () => {
    await cloud.itemPrice.update({ where: { id: priceId }, data: { priceMinor: 12500n } })
    await cloud.itemPrice.delete({ where: { id: goneItemPriceId } })
    await cloud.menuItem.delete({ where: { id: goneItemId } })
    await settle()

    const page = await sync.pull(device, (await readMeta(hub))!.cursor, undefined)
    expect(page.hasMore).toBe(false)
    await applyPull(hub, page)

    const items = await menu()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ priceMinor: 12500 })
    expect((await hubRows('menu_items')).map((r) => r.id)).not.toContain(goneItemId)
    expect((await readMeta(hub))?.cursor).toBe(page.nextCursor)
  })

  it('re-imports the same bootstrap idempotently', async () => {
    await importBootstrap(hub, payload, dataDir)
    await importBootstrap(hub, payload, dataDir)
    for (const table of CLOUD_TABLES) expect((await hubRows(table)).length, table).toBe(payload.data[table].length)
    expect((await readMeta(hub))?.cursor).toBe(payload.cursor)
  })
})
