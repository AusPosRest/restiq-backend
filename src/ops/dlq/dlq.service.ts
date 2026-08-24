// CAP-7 platform dead-letter queue: browse permanently-rejected sync ops and
// replay them idempotently against the ledger story 4 already created
// (AD-7 - applied_ops + sync_dead_letters are the single source both stories
// consume; this module creates neither).
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma, SyncDeadLetter } from '../../generated/prisma/client'
import { OpsPrincipal, RegionRegistryService } from '../../platform'
import { BulkReplayDto } from './dlq.dtos'

const LIMIT_DEFAULT = 25
const LIMIT_MAX = 100

// A schema mismatch needs an app/server rollout, not a retry - the one reason
// code this build treats as non-recoverable so replay can prove the
// rejected-again outcome (CAP-7 UX: applied / duplicate / rejected-again).
// Documented choice, not a real remediation engine (none exists yet).
const NON_RECOVERABLE_REASON_CODES: ReadonlySet<string> = new Set(['schema_skew'])

export interface DeadLetterView {
  id: string
  tenantId: string
  tenantName: string
  deviceId: string
  deviceLabel: string
  opId: string
  reasonCode: string
  reasonText: string
  // Metadata only - never an order payload body (NFR-15).
  payloadMeta: Prisma.JsonValue
  createdAt: string
  resolvedAt: string | null
}

export interface DeadLetterListResult {
  deadLetters: DeadLetterView[]
  nextCursor: string | null
  total: number
}

export type ReplayStatus = 'applied' | 'duplicate' | 'rejected-again'

export interface ReplayResult {
  id: string
  status: ReplayStatus
}

interface Cursor {
  v: string
  id: string
}

function badRequest(message: string, code = 'validation_failed'): never {
  throw new BadRequestException({ code, message })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value)
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (typeof parsed === 'object' && parsed !== null) {
      const { v, id } = parsed as Partial<Cursor>
      if (typeof v === 'string' && typeof id === 'string') return { v, id }
    }
  } catch {
    // fall through
  }
  badRequest('cursor is not valid')
}

async function setOperatorContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

function toView(row: SyncDeadLetter & { tenant: { name: string }; device: { label: string } }): DeadLetterView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantName: row.tenant.name,
    deviceId: row.deviceId,
    deviceLabel: row.device.label,
    opId: row.opId,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    payloadMeta: row.payloadMeta,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }
}

@Injectable()
export class DlqService {
  constructor(private readonly registry: RegionRegistryService) {}

  // --- Fleet-wide read: unresolved rows only, newest-first (matches the
  // devices/sync-health cursor pattern).

  async list(query: Record<string, string | undefined>): Promise<DeadLetterListResult> {
    const tenantId = query.tenantId
    if (tenantId !== undefined && !isUuid(tenantId)) badRequest('tenantId is not a valid id')
    const deviceId = query.deviceId
    if (deviceId !== undefined && !isUuid(deviceId)) badRequest('deviceId is not a valid id')
    const reasonCode = query.reasonCode
    const limit = query.limit === undefined ? LIMIT_DEFAULT : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) badRequest(`limit must be an integer between 1 and ${LIMIT_MAX}`)
    const cursor = query.cursor === undefined || query.cursor === '' ? undefined : decodeCursor(query.cursor)

    const where: Prisma.SyncDeadLetterWhereInput = {
      resolvedAt: null,
      ...(tenantId && { tenantId }),
      ...(deviceId && { deviceId }),
      ...(reasonCode && { reasonCode }),
    }
    if (cursor) {
      where.AND = [{ OR: [{ createdAt: { lt: new Date(cursor.v) } }, { createdAt: new Date(cursor.v), id: { lt: cursor.id } }] }]
    }

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const [rows, total] = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      return Promise.all([
        tx.syncDeadLetter.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          include: { tenant: { select: { name: true } }, device: { select: { label: true } } },
        }),
        tx.syncDeadLetter.count({ where: { ...where, AND: undefined } }),
      ])
    })

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor = rows.length > limit && last ? encodeCursor({ v: last.createdAt.toISOString(), id: last.id }) : null

    return { deadLetters: page.map(toView), nextCursor, total }
  }

  // --- Mutations: idempotent replay (AD-7). Each op resolves in its own
  // transaction (same write-and-audit-together pattern as devices.revoke).

  async replay(operator: OpsPrincipal, id: string, reason: string): Promise<ReplayResult> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      const row = await tx.syncDeadLetter.findUnique({ where: { id } })
      if (!row) throw new NotFoundException({ code: 'not_found', message: 'No such dead-lettered operation' })
      return this.replayRow(tx, row, operator, reason)
    })
  }

  async replayBulk(operator: OpsPrincipal, dto: BulkReplayDto): Promise<{ results: ReplayResult[] }> {
    const hasIds = !!dto.ids && dto.ids.length > 0
    const hasFilter = !!(dto.tenantId ?? dto.deviceId ?? dto.reasonCode)
    if (!hasIds && !hasFilter) badRequest('Provide either an id list or a filter (tenantId, deviceId, reasonCode)')

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const rows = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      if (hasIds) return tx.syncDeadLetter.findMany({ where: { id: { in: dto.ids } } })
      return tx.syncDeadLetter.findMany({
        where: {
          resolvedAt: null,
          ...(dto.tenantId && { tenantId: dto.tenantId }),
          ...(dto.deviceId && { deviceId: dto.deviceId }),
          ...(dto.reasonCode && { reasonCode: dto.reasonCode }),
        },
      })
    })

    const results: ReplayResult[] = []
    for (const row of rows) {
      const result = await plane.$transaction(async (tx) => {
        await setOperatorContext(tx)
        return this.replayRow(tx, row, operator, dto.reason)
      })
      results.push(result)
    }
    return { results }
  }

  private async replayRow(tx: Prisma.TransactionClient, row: SyncDeadLetter, operator: OpsPrincipal, reason: string): Promise<ReplayResult> {
    // Idempotency contract (AD-7): a ledger hit is a no-op, full stop - no
    // write of any kind, so a second replay of an applied op truly has zero
    // side effects.
    const existing = await tx.appliedOp.findUnique({ where: { opId: row.opId } })
    if (existing) return { id: row.id, status: 'duplicate' }

    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${row.tenantId}, true)`

    if (NON_RECOVERABLE_REASON_CODES.has(row.reasonCode)) {
      // Still an operator-triggered mutation worth auditing, even though the
      // op itself stays unresolved and back in the queue for remediation.
      await tx.auditEvent.create({
        data: { tenantId: row.tenantId, actorId: operator.id, actorEmail: operator.email, action: 'dlq.replay_rejected', reason, occurredAt: new Date() },
      })
      return { id: row.id, status: 'rejected-again' }
    }

    await tx.appliedOp.create({ data: { opId: row.opId } })
    await tx.syncDeadLetter.update({ where: { id: row.id }, data: { resolvedAt: new Date() } })
    await tx.auditEvent.create({
      data: { tenantId: row.tenantId, actorId: operator.id, actorEmail: operator.email, action: 'dlq.replayed', reason, occurredAt: new Date() },
    })
    return { id: row.id, status: 'applied' }
  }
}
