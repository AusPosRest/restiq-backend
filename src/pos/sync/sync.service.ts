// Offline sync, read side (restiq-backend#185, docs/SYNC-DESIGN.md §4, §6).
// Bootstrap and pull both hand the hub till plain table rows (column names as
// in the database) for the cloud-owned tables, so the hub can load them into
// its own copy of the schema with one generic path, and pull is just "the
// rows that changed since the cursor".
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { DevicePrincipal, permissionsFor, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../tenant-context'

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>

/** The tables the cloud owns (same list as the sync_record_change trigger). */
export const CLOUD_TABLES = [
  'outlets',
  'menu_categories',
  'menu_items',
  'item_variants',
  'item_prices',
  'modifier_groups',
  'modifiers',
  'item_modifier_groups',
  'combos',
  'combo_slots',
  'combo_slot_options',
  'item_outlet_overrides',
  'floors',
  'dining_tables',
  'stations',
  'roles',
  'staff_users',
  'tenant_tax_registrations',
  'printers',
] as const
type CloudTable = (typeof CLOUD_TABLES)[number]

// Tables whose rows belong to one outlet (outlet_id, null = every outlet).
const OUTLET_SCOPED: ReadonlySet<CloudTable> = new Set(['item_prices', 'item_outlet_overrides', 'floors', 'stations', 'printers'])

// How often the hub should sync when online.
const SYNC_INTERVAL_SECONDS = 30
// ponytail: a change becomes visible to pull only once it is this old, so a
// slower transaction that took a lower id but committed later is not skipped
// past. Holds while no admin write transaction runs longer than this; switch
// to a commit-ordered feed (logical replication) if that ever stops holding.
const SETTLE_SECONDS = 30
const PULL_LIMIT_DEFAULT = 500
const PULL_LIMIT_MAX = 1000

export interface SyncPolicy {
  maxOfflineHours: number
  syncIntervalSeconds: number
}

export interface SyncChangeView {
  entity: string
  id: string
  action: 'upsert' | 'delete'
  version: number
  data?: Row
}

function isCloudTable(name: string): name is CloudTable {
  return (CLOUD_TABLES as readonly string[]).includes(name)
}

// Table names below only ever come from CLOUD_TABLES, never from a request.
// $1 = tenant, $2 = outlet. The explicit tenant filter sits on top of RLS, as
// everywhere else in this codebase.
function scopeSql(table: CloudTable): string {
  const tenant = 't.tenant_id = $1::uuid'
  if (table === 'outlets') return `${tenant} AND t.id = $2::uuid`
  if (table === 'dining_tables') return `${tenant} AND t.floor_id IN (SELECT id FROM floors WHERE outlet_id = $2::uuid)`
  if (OUTLET_SCOPED.has(table)) return `${tenant} AND (t.outlet_id IS NULL OR t.outlet_id = $2::uuid)`
  // Tenant-wide row. $2 is still named so Postgres can type every parameter.
  return `${tenant} AND $2::uuid IS NOT NULL`
}

@Injectable()
export class SyncService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  private async policy(tx: Tx, tenantId: string): Promise<SyncPolicy> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { maxOfflineHours: true } })
    return { maxOfflineHours: tenant.maxOfflineHours, syncIntervalSeconds: SYNC_INTERVAL_SECONDS }
  }

  private async settledCursor(tx: Tx, tenantId: string): Promise<bigint> {
    const [{ max }] = await tx.$queryRaw<[{ max: bigint | null }]>`
      SELECT max(id) AS max FROM sync_changes WHERE tenant_id = ${tenantId}::uuid AND changed_at < now() - make_interval(secs => ${SETTLE_SECONDS})`
    return max ?? 0n
  }

  private async markSynced(tx: Tx, deviceId: string): Promise<void> {
    await tx.device.update({ where: { id: deviceId }, data: { lastSyncAt: new Date() } })
  }

  async bootstrap(device: DevicePrincipal): Promise<{ cursor: string; outletId: string; policy: SyncPolicy; permissions: Record<string, readonly string[]>; data: Record<string, Row[]> }> {
    return this.plane().$transaction(
      async (tx) => {
        await setTenantContext(tx, device.tenantId)
        // Cursor first: anything changing while the rows are read lands after
        // it and is sent again by the next pull - an upsert, so harmless.
        const cursor = await this.settledCursor(tx, device.tenantId)
        const data: Record<string, Row[]> = {}
        for (const table of CLOUD_TABLES) {
          const [{ rows }] = await tx.$queryRawUnsafe<[{ rows: Row[] }]>(
            `SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM "${table}" t WHERE ${scopeSql(table)}`,
            device.tenantId,
            device.outletId,
          )
          data[table] = rows
        }
        // Roles carry no permission column - the catalogue lives in code (#169).
        const permissions = Object.fromEntries((data.roles ?? []).map((r) => [String(r.name), permissionsFor(String(r.name))]))
        const policy = await this.policy(tx, device.tenantId)
        await this.markSynced(tx, device.deviceId)
        return { cursor: cursor.toString(), outletId: device.outletId, policy, permissions, data }
      },
      { isolationLevel: 'RepeatableRead' },
    )
  }

  async pull(device: DevicePrincipal, cursorParam: string | undefined, limitParam: string | undefined) {
    if (!cursorParam || !/^\d{1,19}$/.test(cursorParam)) {
      throw new BadRequestException({ code: 'validation_failed', message: 'cursor must be the cursor from bootstrap or the last pull' })
    }
    const limit = limitParam === undefined ? PULL_LIMIT_DEFAULT : Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > PULL_LIMIT_MAX) {
      throw new BadRequestException({ code: 'validation_failed', message: `limit must be 1 to ${PULL_LIMIT_MAX}` })
    }
    const cursor = BigInt(cursorParam)

    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, device.tenantId)
      const upper = await this.settledCursor(tx, device.tenantId)
      const rows = await tx.$queryRaw<{ id: bigint; entity: string; entity_id: string; action: string }[]>`
        SELECT id, entity, entity_id, action FROM sync_changes
        WHERE tenant_id = ${device.tenantId}::uuid AND id > ${cursor} AND id <= ${upper}
          AND (outlet_id IS NULL OR outlet_id = ${device.outletId}::uuid)
        ORDER BY id LIMIT ${limit}`

      // Latest change per row wins; the row itself is read as it is now.
      const latest = new Map<string, (typeof rows)[number]>()
      for (const row of rows) latest.set(`${row.entity}:${row.entity_id}`, row)

      const changes: SyncChangeView[] = []
      for (const change of latest.values()) {
        if (!isCloudTable(change.entity)) continue
        const version = Number(change.id)
        if (change.action === 'delete') {
          changes.push({ entity: change.entity, id: change.entity_id, action: 'delete', version })
          continue
        }
        const [found] = await tx.$queryRawUnsafe<{ row: Row }[]>(
          `SELECT to_jsonb(t) AS row FROM "${change.entity}" t WHERE t.id = $3::uuid AND ${scopeSql(change.entity)}`,
          device.tenantId,
          device.outletId,
          change.entity_id,
        )
        changes.push(
          found
            ? { entity: change.entity, id: change.entity_id, action: 'upsert', version, data: found.row }
            : { entity: change.entity, id: change.entity_id, action: 'delete', version },
        )
      }
      changes.sort((a, b) => a.version - b.version)

      await this.markSynced(tx, device.deviceId)
      const next = rows.length > 0 ? rows[rows.length - 1].id : cursor
      return { changes, nextCursor: next.toString(), hasMore: rows.length === limit, serverTime: new Date().toISOString() }
    })
  }

  async sessionStatus(device: DevicePrincipal) {
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, device.tenantId)
      const row = await tx.device.findUniqueOrThrow({ where: { id: device.deviceId }, select: { status: true, lastSyncAt: true, enrolledAt: true } })
      const policy = await this.policy(tx, device.tenantId)
      const since = row.lastSyncAt ?? row.enrolledAt
      const mustSyncBefore = new Date(since.getTime() + policy.maxOfflineHours * 3600 * 1000)
      // The guard already refused a revoked device; these stay in the shape
      // the planned contract gives so a hub reads one answer either way.
      return { active: row.status === 'active', revoked: row.status !== 'active', policy, mustSyncBefore: mustSyncBefore.toISOString() }
    })
  }

  async rejections(device: DevicePrincipal, since: string | undefined, includeAcknowledged: string | undefined) {
    const sinceDate = since === undefined ? undefined : new Date(since)
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      throw new BadRequestException({ code: 'validation_failed', message: 'since must be an ISO timestamp' })
    }
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, device.tenantId)
      const letters = await tx.syncDeadLetter.findMany({
        where: {
          deviceId: device.deviceId,
          ...(sinceDate && { createdAt: { gte: sinceDate } }),
          ...(includeAcknowledged !== 'true' && { resolvedAt: null }),
        },
        orderBy: { createdAt: 'asc' },
      })
      return letters.map((l) => {
        const meta = (l.payloadMeta ?? {}) as { type?: string }
        return { opId: l.opId, type: meta.type ?? 'unknown', code: l.reasonCode, message: l.reasonText, at: l.createdAt.toISOString(), acknowledged: l.resolvedAt !== null }
      })
    })
  }

  async acknowledge(device: DevicePrincipal, opId: string): Promise<void> {
    await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, device.tenantId)
      const result = await tx.syncDeadLetter.updateMany({ where: { deviceId: device.deviceId, opId, resolvedAt: null }, data: { resolvedAt: new Date() } })
      if (result.count === 0) {
        const exists = await tx.syncDeadLetter.count({ where: { deviceId: device.deviceId, opId } })
        if (exists === 0) throw new NotFoundException({ code: 'not_found', message: 'No such rejected operation for this device' })
      }
    })
  }
}
