// Hub mode (#293) on in-memory PGlite - no Postgres needed, so this runs in
// the plain `pnpm test` job: every migration applies, RLS holds under the app
// role, PIN login and the menu work through the real POS code, and anything
// off the allowlist answers 404 not_on_hub.
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HUB_PIN, seedHubTenant, type HubSeed } from '../../test/hub-seed'
import { setPrismaClient, type PrismaClient } from '../db/client'
import { uuidv7 } from '../platform'
import { createHubApp } from './hub.module'
import { APP_ROLE, applyMigrations, openStore } from './store'

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations')

describe('hub mode on PGlite', () => {
  let pg: PGlite
  let prisma: PrismaClient
  let app: INestApplication
  let http: Parameters<typeof request>[0]
  let a: HubSeed
  let b: HubSeed
  const journalDir = mkdtempSync(join(tmpdir(), 'restiq-hub-spec-'))

  beforeAll(async () => {
    process.env.POS_JWT_SECRET = 'hub-spec-secret'
    ;({ pg, prisma } = await openStore(undefined, MIGRATIONS))
    setPrismaClient(prisma)
    a = await seedHubTenant(pg, prisma, 'Tenant A')
    b = await seedHubTenant(pg, prisma, 'Tenant B')
    app = await createHubApp(pg, journalDir)
    await app.init()
    http = app.getHttpServer() as Parameters<typeof request>[0]
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pg?.close()
    rmSync(journalDir, { recursive: true, force: true })
  })

  it('applies every migration once, and none again on reopen', async () => {
    const applied = await pg.query<{ count: number }>('SELECT count(*)::int AS count FROM hub_migrations')
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    expect(applied.rows[0]?.count).toBe(dirs.length)
    await pg.exec('RESET ROLE')
    try {
      expect(await applyMigrations(pg, MIGRATIONS)).toEqual([])
    } finally {
      await pg.exec(`SET ROLE ${APP_ROLE}`)
    }
  })

  it('logs a cashier in by PIN and serves the menu', async () => {
    const login = await request(http).post('/pos/v1/auth/login').send({ tenantId: a.tenantId, pin: HUB_PIN }).expect(200)
    expect(login.body).toMatchObject({ status: 'authenticated', staff: { id: a.staffId }, outlet: { id: a.outletId } })
    const token = (login.body as { token: string }).token

    const menu = await request(http).get('/pos/v1/menu').set('Authorization', `Bearer ${token}`).expect(200)
    const items = (menu.body as { items: { id: string; priceMinor: number | null }[] }).items
    expect(items).toEqual([expect.objectContaining({ id: a.itemId, priceMinor: 12000 })])
  })

  it('refuses a wrong PIN', async () => {
    await request(http).post('/pos/v1/auth/login').send({ tenantId: a.tenantId, pin: '0000' }).expect(401)
  })

  it('answers 404 not_on_hub off the allowlist, even for routes the cloud has', async () => {
    for (const [method, path] of [
      ['get', '/sync/v1/bootstrap'],
      ['get', '/ops/v1/tenants'],
      ['post', '/admin/v1/auth/login'],
      ['get', '/health/db'],
      ['get', '/nope'],
    ] as const) {
      const res = await request(http)[method](path).expect(404)
      expect(res.body).toMatchObject({ error: { code: 'not_on_hub' } })
    }
    await request(http).get('/health').expect(200)
  })

  // Ported from the spike's rls-check: the app role sees only the tenant in context and cannot write another's rows.
  it('holds RLS under the app role', async () => {
    expect((await pg.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user).toBe(APP_ROLE)
    await pg.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId])
      expect((await tx.query<{ id: string }>('SELECT id FROM tenants')).rows).toEqual([{ id: a.tenantId }])
      expect((await tx.query<{ id: string }>('SELECT id FROM outlets')).rows).toEqual([{ id: a.outletId }])
      expect((await tx.query<{ id: string }>('SELECT id FROM staff_users')).rows).toEqual([{ id: a.staffId }])
      expect((await tx.query<{ id: string }>('SELECT id FROM menu_items')).rows).toEqual([{ id: a.itemId }])
    })
    await expect(
      pg.transaction(async (tx) => {
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId])
        await tx.query(`INSERT INTO brands (id, tenant_id, name) VALUES ($1, $2, 'Smuggled')`, [uuidv7(), b.tenantId])
      }),
    ).rejects.toThrow(/row-level security/)
  })
})
