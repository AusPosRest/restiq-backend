// Hub mode (#304, HUB-BUILD-PLAN H4): the hub's link to the cloud. Every
// policy.syncIntervalSeconds, and right after each recorded write, one tick:
// session-status -> (first run: bootstrap) -> push the outbox -> pull ->
// cache rejections -> heartbeat. Ticks never overlap. While the cloud can't be
// reached the hub keeps selling; ticks back off 1 s -> 60 s (SYNC-DESIGN §5-§7, §9).
import type { PGlite } from '@electric-sql/pglite'
import { Logger } from '@nestjs/common'
import type { KeyObject } from 'node:crypto'
import { uuidv7 } from '../platform'
import { SYNC_BATCH_MAX, type SyncOpResult } from '../pos/sync/sync.dtos'
import { applyPull, importBootstrap, type BootstrapPayload, type PullPage } from './import'
import { readAck, writeAck } from './journal'
import { readMeta } from './meta'
import { outboxDepth, readUnacked } from './outbox'
import { signatureHeaders } from './signer'

const DEFAULT_INTERVAL_MS = 15_000
const BACKOFF_CAP_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

/** Wait before the next tick after `failures` failed ticks in a row: 1 s, 2 s, 4 s ... 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(failures - 1, 0), BACKOFF_CAP_MS)
}

/** The cloud answered with an error. code is the API's error.code. */
export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly serverTime?: string,
  ) {
    super(message)
  }
}

export interface SyncWorkerOptions {
  pg: PGlite
  dataDir: string
  /** The cloud API base URL, e.g. https://api.example.com */
  cloudUrl: string
  deviceId: string
  key: KeyObject
  appVersion: string
}

interface CloudRejection {
  opId: string
  type: string
  code: string
  message: string
  at: string
  acknowledged: boolean
}

export class SyncWorker {
  private readonly logger = new Logger('SyncWorker')
  private current?: Promise<void>
  private next?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private intervalMs = DEFAULT_INTERVAL_MS
  /** Failed ticks in a row (0 when the last one worked). */
  failures = 0
  online = false
  lastError: string | null = null
  /** Set when a push stopped at an op the cloud deferred (a seq gap): the op stays in the outbox. */
  blockedAt: { seq: number; code: string } | null = null
  clockSkewSeconds = 0

  constructor(private readonly o: SyncWorkerOptions) {}

  start(): void {
    void this.sync()
  }

  /** Sync soon: now when idle, else once more right after the tick in flight. */
  kick(): void {
    void this.sync()
  }

  /** Runs a tick; while one runs, queues at most one more. Resolves when the tick that covers this call is done. */
  sync(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (!this.current) {
      clearTimeout(this.timer)
      this.current = this.tick()
        .catch((error: unknown) => this.logger.error(`sync tick crashed: ${String(error)}`))
        .finally(() => {
          this.current = undefined
          this.schedule()
        })
      return this.current
    }
    this.next ??= this.current.then(() => {
      this.next = undefined
      return this.sync()
    })
    return this.next
  }

  /** Stops the timer and waits for any tick in flight - call before closing PGlite. */
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.next
    await this.current
  }

  get isStopped(): boolean {
    return this.stopped
  }

  /** What the hub status endpoint (H6) shows. */
  async status() {
    const meta = await readMeta(this.o.pg)
    return {
      online: this.online,
      lastSyncAt: meta?.lastSyncAt ?? null,
      mustSyncBefore: meta?.mustSyncBefore ?? null,
      outboxDepth: await outboxDepth(this.o.pg),
      locked: meta?.locked ?? false,
      lockReason: meta?.lockReason ?? null,
      clockSkewSeconds: this.clockSkewSeconds,
      lastError: this.lastError,
      blockedAt: this.blockedAt,
    }
  }

  private schedule(): void {
    if (this.stopped || this.next) return
    this.timer = setTimeout(() => this.kick(), this.failures > 0 ? backoffMs(this.failures) : this.intervalMs)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    if ((await readMeta(this.o.pg))?.lockReason === 'revoked') {
      this.stopped = true
      return
    }
    try {
      await this.pass()
      this.failures = 0
      this.online = true
      this.lastError = null
    } catch (error) {
      this.failures++
      this.online = false
      this.lastError = error instanceof Error ? error.message : String(error)
      if (error instanceof CloudError && error.code === 'device_revoked') {
        await this.revoke()
        return
      }
      if (error instanceof CloudError && error.code === 'clock_skew') this.skewFrom(error.serverTime)
      this.logger.warn(`sync failed (${this.failures} in a row): ${this.lastError}`)
    }
    await this.o.pg.query('UPDATE hub_meta SET online = $1, clock_skew_seconds = $2', [this.online, this.clockSkewSeconds])
  }

  private async pass(): Promise<void> {
    const status = await this.call<{ policy: { maxOfflineHours: number; syncIntervalSeconds: number } }>('GET', '/sync/v1/session-status')
    this.intervalMs = status.policy.syncIntervalSeconds * 1000 || DEFAULT_INTERVAL_MS
    if (!(await readMeta(this.o.pg))) await this.bootstrap(true)
    else await this.o.pg.query('UPDATE hub_meta SET policy = $1::jsonb', [JSON.stringify(status.policy)])
    await this.push()
    await this.pull()
    await this.cacheRejections()
    await this.call('POST', '/sync/v1/heartbeat', {
      outboxDepth: Math.min(await outboxDepth(this.o.pg), 100_000),
      appVersion: this.o.appVersion,
      clockSkewSeconds: Math.max(-3600, Math.min(3600, this.clockSkewSeconds)),
      recentRejectionCount: (await this.o.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM hub_rejections WHERE NOT acknowledged')).rows[0].n,
    })
  }

  /** Open sales come along only on a first bootstrap or with nothing unpushed - otherwise the hub's own sales are newer. */
  private async bootstrap(withOpenSales: boolean): Promise<void> {
    const payload = await this.call<BootstrapPayload>('GET', `/sync/v1/bootstrap${withOpenSales ? '?include=open_sales' : ''}`)
    await importBootstrap(this.o.pg, payload, this.o.dataDir)
    await this.o.pg.query('UPDATE hub_meta SET device_id = $1', [this.o.deviceId])
  }

  private async push(): Promise<void> {
    this.blockedAt = null
    for (;;) {
      const ops = await readUnacked(this.o.pg, SYNC_BATCH_MAX)
      if (ops.length === 0) return
      const { results, serverTime } = await this.call<{ results: SyncOpResult[]; serverTime: string }>('POST', '/sync/v1/push', { batchId: uuidv7(), ops })
      this.skewFrom(serverTime)
      const byId = new Map(results.map((result) => [result.opId, result]))
      // Ops are in seq order and the cloud defers everything after a gap, so the acked ones are a prefix.
      const done: { seq: number; result: SyncOpResult; type: string }[] = []
      for (const op of ops) {
        const result = byId.get(op.opId)
        if (!result || result.status === 'deferred') {
          this.blockedAt = { seq: op.seq, code: result?.code ?? 'no_result' }
          break
        }
        done.push({ seq: op.seq, result, type: op.type })
      }
      await this.o.pg.transaction(async (tx) => {
        for (const { result, type } of done) {
          await tx.query('UPDATE hub_outbox SET acked_at = now(), result = $2::jsonb WHERE op_id = $1', [result.opId, JSON.stringify(result)])
          if (result.status === 'rejected') {
            await tx.query('INSERT INTO hub_rejections (op_id, type, code, message, at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (op_id) DO NOTHING', [
              result.opId,
              type,
              result.code ?? 'rejected',
              result.message ?? 'Rejected',
            ])
          }
        }
      })
      // The cloud applies seq strictly in order, so an answer for seq n means it holds every op up to n.
      if (done.length > 0) writeAck(this.o.dataDir, Math.max(readAck(this.o.dataDir), ...done.map((d) => d.seq)))
      if (this.blockedAt) {
        this.logger.warn(`push stopped at seq ${this.blockedAt.seq} (${this.blockedAt.code}); it and later ops stay in the outbox`)
        return
      }
    }
  }

  private async pull(): Promise<void> {
    for (;;) {
      const { cursor } = (await readMeta(this.o.pg))!
      let page: PullPage
      try {
        page = await this.call<PullPage>('GET', `/sync/v1/pull?cursor=${cursor}`)
      } catch (error) {
        if (!(error instanceof CloudError && error.status === 410)) throw error
        this.logger.warn('pull cursor expired; bootstrapping again')
        await this.bootstrap((await outboxDepth(this.o.pg)) === 0)
        return
      }
      // applyPull only touches CLOUD_TABLES: the hub's own sales rows are never overwritten.
      await applyPull(this.o.pg, page)
      this.skewFrom(page.serverTime)
      if (!page.hasMore) return
    }
  }

  private async cacheRejections(): Promise<void> {
    const list = await this.call<CloudRejection[]>('GET', '/sync/v1/rejections')
    await this.o.pg.transaction(async (tx) => {
      await tx.query('DELETE FROM hub_rejections')
      await tx.query(
        `INSERT INTO hub_rejections (op_id, type, code, message, at, acknowledged)
         SELECT "opId", type, code, message, at, acknowledged
         FROM jsonb_to_recordset($1::jsonb) AS r("opId" uuid, type text, code text, message text, at timestamptz, acknowledged boolean)`,
        [JSON.stringify(list)],
      )
    })
  }

  /** M7: lock with reason revoked and forget every staff PIN, then stop for good. Unsynced ops stay on disk for ops to recover. */
  private async revoke(): Promise<void> {
    this.stopped = true
    this.logger.error('this device has been revoked: hub locked, staff PINs cleared')
    await this.o.pg.transaction(async (tx) => {
      // Superuser past RLS, triggers off - as the bootstrap import writes.
      await tx.exec('SET LOCAL ROLE NONE; SET LOCAL session_replication_role = replica')
      await tx.query('UPDATE staff_users SET pin_hash = NULL')
      await tx.query(`UPDATE hub_meta SET locked = true, lock_reason = 'revoked', online = false`)
    })
  }

  private skewFrom(serverTime: string | undefined): void {
    const at = serverTime === undefined ? NaN : Date.parse(serverTime)
    if (!Number.isNaN(at)) this.clockSkewSeconds = Math.round((at - Date.now()) / 1000)
  }

  private async call<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const base = this.o.cloudUrl.endsWith('/') ? this.o.cloudUrl : `${this.o.cloudUrl}/`
    const url = new URL(path.slice(1), base)
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const res = await fetch(url, {
      method,
      headers: {
        ...signatureHeaders(this.o.key, this.o.deviceId, method, url.pathname + url.search, body),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      let error: { code?: string; message?: string; serverTime?: string } = {}
      try {
        error = ((await res.json()) as { error?: typeof error }).error ?? {}
      } catch {
        // not JSON
      }
      throw new CloudError(res.status, error.code, `${method} ${url.pathname}: ${res.status} ${error.code ?? ''} ${error.message ?? ''}`.trim(), error.serverTime)
    }
    return (res.status === 204 ? undefined : await res.json()) as T
  }
}
