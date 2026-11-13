// Hub mode (#296, HUB-BUILD-PLAN H2): the hub's own sync state - which tenant,
// outlet and device it is, the pull cursor, the cloud's policy and the O1 lock.
// Hub-only: not a Prisma migration, created by the store after migrations.
import type { PGlite } from '@electric-sql/pglite'

export interface HubMeta {
  tenantId: string
  outletId: string
  deviceId: string | null
  cursor: string
  policy: { maxOfflineHours: number; syncIntervalSeconds: number }
  permissions: Record<string, string[]>
  lastSyncAt: Date | null
  mustSyncBefore: Date | null
  locked: boolean
  lockReason: string | null
  /** H4: whether the sync worker's last tick reached the cloud; lastSyncAt is the last successful pull. */
  online: boolean
  /** H4: cloud time minus hub time, from the cloud's serverTime. */
  clockSkewSeconds: number
}

/** One row (id is always true). deviceId is set by the sync worker (H4); the rest by the bootstrap import. */
export async function createMetaTable(pg: PGlite): Promise<void> {
  await pg.exec(`CREATE TABLE IF NOT EXISTS hub_meta (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    tenant_id uuid NOT NULL,
    outlet_id uuid NOT NULL,
    device_id uuid,
    cursor bigint NOT NULL,
    policy jsonb NOT NULL,
    permissions jsonb NOT NULL,
    last_sync_at timestamptz,
    must_sync_before timestamptz,
    locked boolean NOT NULL DEFAULT false,
    lock_reason text,
    online boolean NOT NULL DEFAULT false,
    clock_skew_seconds int NOT NULL DEFAULT 0
  )`)
}

/** The hub's sync state, or undefined before the first bootstrap. */
export async function readMeta(pg: Pick<PGlite, 'query'>): Promise<HubMeta | undefined> {
  const { rows } = await pg.query<HubMeta>(`
    SELECT tenant_id AS "tenantId", outlet_id AS "outletId", device_id AS "deviceId", cursor::text AS cursor,
      policy, permissions, last_sync_at AS "lastSyncAt", must_sync_before AS "mustSyncBefore", locked, lock_reason AS "lockReason",
      online, clock_skew_seconds AS "clockSkewSeconds"
    FROM hub_meta`)
  return rows[0]
}
