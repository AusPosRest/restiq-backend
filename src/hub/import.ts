// Hub mode (#296, HUB-BUILD-PLAN H2): loads the cloud's bootstrap snapshot and
// pull pages into the hub's PGlite store. No network here - the sync worker
// (H4) fetches and hands the payloads over.
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOUD_TABLES, type SyncService } from '../pos/sync/sync.service'

export type BootstrapPayload = Awaited<ReturnType<SyncService['bootstrap']>>
export type PullPage = Awaited<ReturnType<SyncService['pull']>>
type CloudTable = (typeof CLOUD_TABLES)[number]

// Back to PGlite's superuser (session user) for this transaction only, with FK
// and sync_record_change triggers off: rows arrive parent-less (other outlets,
// tables not synced) and the hub keeps no change feed. SET LOCAL ends with the
// transaction, so the connection is back on restiq_app (RLS) even on error.
// ponytail: no extra mutex - PGlite runs query/exec/transaction under one
// exclusive lock, so no Prisma query can run inside this transaction.
async function asImporter(pg: PGlite, fn: (tx: Transaction) => Promise<void>): Promise<void> {
  await pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE; SET LOCAL session_replication_role = replica')
    await fn(tx)
  })
}

/** Upserts rows (column names as in the database) into one table. Table names only ever come from CLOUD_TABLES. */
async function upsert(tx: Transaction, table: CloudTable, rows: unknown[], columns: Map<CloudTable, string>): Promise<void> {
  if (rows.length === 0) return
  let set = columns.get(table)
  if (set === undefined) {
    const { rows: cols } = await tx.query<{ name: string }>(
      `SELECT attname AS name FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'id' ORDER BY attnum`,
      [table],
    )
    set = cols.map(({ name }) => `"${name}" = EXCLUDED."${name}"`).join(', ')
    columns.set(table, set)
  }
  // Keys the hub's schema lacks (a newer cloud) are ignored; columns the payload lacks become null.
  await tx.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(null::"${table}", $1::jsonb) ON CONFLICT (id) DO UPDATE SET ${set}`, [
    JSON.stringify(rows),
  ])
}

const MUST_SYNC_BEFORE = `now() + make_interval(hours => (policy->>'maxOfflineHours')::int)`

/**
 * Replaces the hub's copy of the cloud-owned tables with the snapshot (rows the
 * snapshot no longer has are deleted), records tenant, outlet, cursor and
 * policy in hub_meta - one transaction - then keeps the payload as
 * dataDir/bootstrap.json for offline recovery (H5).
 */
export async function importBootstrap(pg: PGlite, payload: BootstrapPayload, dataDir: string): Promise<void> {
  const tenantId = payload.data.tenants?.[0]?.id
  if (typeof tenantId !== 'string') throw new Error('bootstrap has no tenant row')
  const columns = new Map<CloudTable, string>()
  await asImporter(pg, async (tx) => {
    // Children first for the deletes, parents first for the upserts (FKs are off either way; this keeps it readable).
    for (const table of [...CLOUD_TABLES].reverse()) {
      await tx.query(`DELETE FROM "${table}" WHERE id NOT IN (SELECT (r->>'id')::uuid FROM jsonb_array_elements($1::jsonb) r)`, [
        JSON.stringify(payload.data[table] ?? []),
      ])
    }
    for (const table of CLOUD_TABLES) await upsert(tx, table, payload.data[table] ?? [], columns)
    await tx.query(
      `INSERT INTO hub_meta (tenant_id, outlet_id, cursor, policy, permissions, last_sync_at, must_sync_before)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, now(), now() + make_interval(hours => ($4::jsonb->>'maxOfflineHours')::int))
       ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, outlet_id = EXCLUDED.outlet_id, cursor = EXCLUDED.cursor,
         policy = EXCLUDED.policy, permissions = EXCLUDED.permissions, last_sync_at = EXCLUDED.last_sync_at, must_sync_before = EXCLUDED.must_sync_before`,
      [tenantId, payload.outletId, payload.cursor, JSON.stringify(payload.policy), JSON.stringify(payload.permissions)],
    )
  })
  writeDurably(join(dataDir, 'bootstrap.json'), JSON.stringify(payload))
}

/** Applies one pull page in version order and saves its nextCursor, in one transaction. */
export async function applyPull(pg: PGlite, page: PullPage): Promise<void> {
  const columns = new Map<CloudTable, string>()
  await asImporter(pg, async (tx) => {
    for (const change of [...page.changes].sort((a, b) => a.version - b.version)) {
      const table = CLOUD_TABLES.find((name) => name === change.entity)
      if (!table) continue // a table this hub's schema doesn't sync (a newer cloud)
      if (change.action === 'delete') {
        await tx.query(`DELETE FROM "${table}" WHERE id = $1::uuid`, [change.id])
      } else {
        if (!change.data) throw new Error(`pull upsert of ${table} ${change.id} has no row`)
        await upsert(tx, table, [change.data], columns)
      }
    }
    const { affectedRows } = await tx.query(`UPDATE hub_meta SET cursor = $1, last_sync_at = now(), must_sync_before = ${MUST_SYNC_BEFORE}`, [page.nextCursor])
    if (!affectedRows) throw new Error('the hub has not been bootstrapped')
  })
}

// Temp file + fsync + rename, so a power cut leaves the old file or the new one, never half of one.
// ponytail: the directory itself is not fsynced (Windows can't); NTFS journals the rename.
function writeDurably(path: string, text: string): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}
