// Hub mode (#293): the till's local store is PGlite (Postgres in WebAssembly),
// so the backend's own migrations, RLS policies and Prisma client run on it
// unchanged (PGlite spike, restiq-desktop#3).
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaPGlite } from 'pglite-prisma-adapter'
import { PrismaClient } from '../generated/prisma/client'

/** PGlite's own user is a superuser, which bypasses RLS - every app query runs as this role instead. */
export const APP_ROLE = 'restiq_app'

/** Applies each prisma/migrations/<dir>/migration.sql not yet recorded in hub_migrations, in name order. Returns the ones applied. */
export async function applyMigrations(db: PGlite, migrationsDir: string): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS hub_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM hub_migrations')).rows.map((row) => row.name))
  const pending = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !done.has(entry.name))
    .map((entry) => entry.name)
    .sort()
  for (const name of pending) {
    const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8')
    // One transaction per migration: a failure leaves neither half a schema change nor the record of it.
    await db.transaction(async (tx) => {
      await tx.exec(sql)
      await tx.query('INSERT INTO hub_migrations (name) VALUES ($1)', [name])
    })
  }
  return pending
}

/** Creates the app role if missing and (re)grants it every table and sequence - run after each migrate, so new tables are covered. */
export async function grantAppRole(db: PGlite): Promise<void> {
  await db.exec(`
    DO $$ BEGIN CREATE ROLE ${APP_ROLE}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
  `)
}

export interface HubStore {
  pg: PGlite
  prisma: PrismaClient
}

/** Opens PGlite at dataDir (in memory when undefined), migrates, then switches its one connection to the app role for Prisma. */
export async function openStore(dataDir: string | undefined, migrationsDir: string): Promise<HubStore> {
  const pg = await PGlite.create(dataDir)
  await applyMigrations(pg, migrationsDir)
  await grantAppRole(pg)
  await pg.exec(`SET ROLE ${APP_ROLE}`)
  return { pg, prisma: new PrismaClient({ adapter: new PrismaPGlite(pg) }) }
}
