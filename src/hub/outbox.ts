// Hub mode (#300, HUB-BUILD-PLAN H3): the ops the hub has made that the cloud
// has not acknowledged yet, in seq order - what the sync worker (H4) pushes.
// Hub-only: not a Prisma migration, created by the store after migrations.
import type { PGlite } from '@electric-sql/pglite'

/** One op, as SyncOpDto carries it to POST /sync/v1/push. */
export interface HubOp {
  opId: string
  seq: number
  type: string
  at: string
  actorStaffId: string
  payload: Record<string, unknown>
}

export async function createOutboxTable(pg: PGlite): Promise<void> {
  await pg.exec(`CREATE TABLE IF NOT EXISTS hub_outbox (
    seq bigint PRIMARY KEY CHECK (seq > 0),
    op_id uuid NOT NULL UNIQUE,
    type text NOT NULL,
    at timestamptz NOT NULL,
    actor_staff_id uuid NOT NULL,
    payload jsonb NOT NULL,
    acked_at timestamptz,
    result jsonb
  )`)
  // H4: ops the cloud refused (from push results and the cached /sync/v1/rejections), for the Sync issues screen (H6).
  await pg.exec(`CREATE TABLE IF NOT EXISTS hub_rejections (
    op_id uuid PRIMARY KEY,
    type text NOT NULL,
    code text NOT NULL,
    message text NOT NULL,
    at timestamptz NOT NULL,
    acknowledged boolean NOT NULL DEFAULT false
  )`)
}

/** The next seq: 1 for the first op, then one more than the last, so pushes see no gap. Call under the write mutex. */
export async function nextSeq(pg: Pick<PGlite, 'query'>): Promise<number> {
  const { rows } = await pg.query<{ seq: number }>('SELECT coalesce(max(seq), 0)::int + 1 AS seq FROM hub_outbox')
  return rows[0].seq
}

export async function insertOp(pg: Pick<PGlite, 'query'>, op: HubOp): Promise<void> {
  await pg.query('INSERT INTO hub_outbox (seq, op_id, type, at, actor_staff_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [
    op.seq,
    op.opId,
    op.type,
    op.at,
    op.actorStaffId,
    JSON.stringify(op.payload),
  ])
}

const SELECT_OPS = `SELECT op_id AS "opId", seq::int AS seq, type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
  actor_staff_id AS "actorStaffId", payload FROM hub_outbox`

/** Every op in seq order (acked or not), as pushed. */
export async function readOutbox(pg: Pick<PGlite, 'query'>): Promise<HubOp[]> {
  return (await pg.query<HubOp>(`${SELECT_OPS} ORDER BY seq`)).rows
}

/** The first `limit` ops the cloud has not acknowledged, in seq order. */
export async function readUnacked(pg: Pick<PGlite, 'query'>, limit: number): Promise<HubOp[]> {
  return (await pg.query<HubOp>(`${SELECT_OPS} WHERE acked_at IS NULL ORDER BY seq LIMIT $1`, [limit])).rows
}

export async function outboxDepth(pg: Pick<PGlite, 'query'>): Promise<number> {
  return (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM hub_outbox WHERE acked_at IS NULL')).rows[0].n
}
