// CAP-4: device fleet and enrolment. Enrolment codes are one-time, 15-minute
// TTL tickets (AD-7 binds CAP-4: no code is ever consumed twice); revocation
// and hub designation are audited mutations in the same transaction as the
// write (AD-6), same pattern as the tenant directory service.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import { OpsPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { DEVICE_STATUSES, DEVICE_TYPES, DeviceTypeValue, EnrollDeviceDto, GenerateCodeDto } from './devices.dtos'

export const CODE_TTL_MS = 15 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1 (unambiguous)
const DEFAULT_CODE_REASON = 'Enrolment code generated for device provisioning'
const DEFAULT_ENROLL_REASON = 'Device enrolled via one-time enrolment code'

const LIMIT_DEFAULT = 25
const LIMIT_MAX = 100

export interface DeviceView {
  id: string
  tenantId: string
  outletId: string | null
  label: string
  type: string
  role: string
  status: string
  enrolledAt: string
  revokedAt: string | null
}

export interface DeviceListItem extends DeviceView {
  tenantName: string
  outletName: string | null
}

export interface DeviceListResult {
  devices: DeviceListItem[]
  nextCursor: string | null
  total: number
}

interface Cursor {
  v: string
  id: string
}

function badRequest(message: string, code = 'validation_failed'): never {
  throw new BadRequestException({ code, message })
}

function parseChoice<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) badRequest(`${label} must be one of: ${allowed.join(', ')}`)
  return value as T
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

function generateRawCode(): string {
  const bytes = randomBytes(6)
  let chars = ''
  for (const byte of bytes) chars += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return `${chars.slice(0, 3)}-${chars.slice(3, 6)}`
}

function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function hashCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex')
}

function defaultLabel(type: string, id: string): string {
  return `${type.toUpperCase()}-${id.slice(0, 8)}`
}

function toDeviceView(device: {
  id: string
  tenantId: string
  outletId: string | null
  label: string
  type: string
  role: string
  status: string
  enrolledAt: Date
  revokedAt: Date | null
}): DeviceView {
  return {
    id: device.id,
    tenantId: device.tenantId,
    outletId: device.outletId,
    label: device.label,
    type: device.type,
    role: device.role,
    status: device.status,
    enrolledAt: device.enrolledAt.toISOString(),
    revokedAt: device.revokedAt ? device.revokedAt.toISOString() : null,
  }
}

async function setOperatorContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

function isRecordNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2025'
}

@Injectable()
export class DevicesService {
  constructor(private readonly registry: RegionRegistryService) {}

  // --- Fleet-wide read (CAP-4 "fleet"): fans out across region planes via the
  // registry (AD-1); v1 has a single plane, so this is a loop of one.

  async list(query: Record<string, string | undefined>): Promise<DeviceListResult> {
    const tenantId = query.tenantId
    if (tenantId !== undefined && !/^[0-9a-f-]{36}$/i.test(tenantId)) badRequest('tenantId is not a valid id')
    const type = parseChoice(query.type, DEVICE_TYPES, 'type')
    const status = parseChoice(query.status, DEVICE_STATUSES, 'status')
    const limit = query.limit === undefined ? LIMIT_DEFAULT : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) badRequest(`limit must be an integer between 1 and ${LIMIT_MAX}`)
    const cursor = query.cursor === undefined || query.cursor === '' ? undefined : decodeCursor(query.cursor)

    const where: Prisma.DeviceWhereInput = {
      ...(tenantId && { tenantId }),
      ...(type && { type }),
      ...(status && { status }),
    }
    if (cursor) {
      where.AND = [{ OR: [{ enrolledAt: { lt: new Date(cursor.v) } }, { enrolledAt: new Date(cursor.v), id: { lt: cursor.id } }] }]
    }

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const [rows, total] = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      return Promise.all([
        tx.device.findMany({
          where,
          orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          include: { tenant: { select: { name: true } }, outlet: { select: { name: true } } },
        }),
        tx.device.count({ where: { ...where, AND: undefined } }),
      ])
    })

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor = rows.length > limit && last ? encodeCursor({ v: last.enrolledAt.toISOString(), id: last.id }) : null

    return {
      devices: page.map((row) => ({ ...toDeviceView(row), tenantName: row.tenant.name, outletName: row.outlet?.name ?? null })),
      nextCursor,
      total,
    }
  }

  // --- Mutations: one transaction each - the write and its audit_events row
  // commit or roll back together (AD-6).

  async generateCode(operator: OpsPrincipal, dto: GenerateCodeDto): Promise<{ code: string; deviceType: DeviceTypeValue; expiresAt: string }> {
    const reason = dto.reason ?? DEFAULT_CODE_REASON
    const plane = this.registry.planeFor(this.registry.homeRegion())

    return plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      const tenant = await tx.tenant.findUnique({ where: { id: dto.tenantId, deletedAt: null }, select: { id: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      const outlet = await tx.outlet.findFirst({ where: { id: dto.outletId, tenantId: dto.tenantId, deletedAt: null } })
      if (!outlet) throw new NotFoundException({ code: 'not_found', message: 'No such outlet for this tenant' })

      const rawCode = generateRawCode()
      const expiresAt = new Date(Date.now() + CODE_TTL_MS)

      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${dto.tenantId}, true)`
      await tx.enrolmentCode.create({
        data: {
          tenantId: dto.tenantId,
          outletId: dto.outletId,
          codeHash: hashCode(normalizeCode(rawCode)),
          deviceType: dto.deviceType,
          expiresAt,
        },
      })
      await tx.auditEvent.create({
        data: {
          tenantId: dto.tenantId,
          actorId: operator.id,
          actorEmail: operator.email,
          action: 'device.enrolment_code_generated',
          reason,
          occurredAt: new Date(),
        },
      })

      return { code: rawCode, deviceType: dto.deviceType, expiresAt: expiresAt.toISOString() }
    })
  }

  async enroll(operator: OpsPrincipal, dto: EnrollDeviceDto): Promise<{ device: DeviceView }> {
    const codeHash = hashCode(normalizeCode(dto.code))
    const reason = dto.reason ?? DEFAULT_ENROLL_REASON
    const plane = this.registry.planeFor(this.registry.homeRegion())

    return plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      const record = await tx.enrolmentCode.findUnique({ where: { codeHash } })
      if (!record) throw new BadRequestException({ code: 'code_invalid', message: 'This enrolment code is not valid' })
      if (record.usedAt) throw new ConflictException({ code: 'code_already_used', message: 'This enrolment code has already been used' })
      if (record.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException({ code: 'code_expired', message: 'This enrolment code has expired' })
      }

      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${record.tenantId}, true)`

      // Atomic consume: a WHERE usedAt IS NULL guard closes the race between
      // two concurrent enrolls racing the same code.
      const consumed = await tx.enrolmentCode.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } })
      if (consumed.count === 0) {
        throw new ConflictException({ code: 'code_already_used', message: 'This enrolment code has already been used' })
      }

      const id = uuidv7()
      const now = new Date()
      const device = await tx.device.create({
        data: {
          id,
          tenantId: record.tenantId,
          outletId: record.outletId,
          label: dto.label?.trim() || defaultLabel(record.deviceType, id),
          type: record.deviceType,
          hardwareKeyFingerprint: dto.hardwareKeyFingerprint,
          enrolledAt: now,
        },
      })
      await tx.auditEvent.create({
        data: {
          tenantId: record.tenantId,
          actorId: operator.id,
          actorEmail: operator.email,
          action: 'device.enrolled',
          reason,
          occurredAt: now,
        },
      })

      return { device: toDeviceView(device) }
    })
  }

  async designateHub(operator: OpsPrincipal, deviceId: string, reason: string): Promise<{ device: DeviceView; displacedDeviceId: string | null }> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    try {
      return await plane.$transaction(async (tx) => {
        await setOperatorContext(tx)
        const device = await tx.device.findUnique({ where: { id: deviceId } })
        if (!device) throw new NotFoundException({ code: 'not_found', message: 'No such device' })
        if (device.status !== 'active') throw new ConflictException({ code: 'conflict', message: 'A revoked device cannot be designated hub' })
        if (!device.outletId) badRequest('Device must belong to an outlet to be designated hub')

        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${device.tenantId}, true)`

        // Hub is explicit and exclusive per outlet - never auto-elected
        // (SPEC success criterion): designating one displaces any other.
        const priorHub = await tx.device.findFirst({
          where: { outletId: device.outletId, role: 'hub', status: 'active', NOT: { id: deviceId } },
        })
        if (priorHub) {
          await tx.device.update({ where: { id: priorHub.id }, data: { role: 'terminal' } })
        }
        const updated = device.role === 'hub' ? device : await tx.device.update({ where: { id: deviceId }, data: { role: 'hub' } })

        await tx.auditEvent.create({
          data: {
            tenantId: device.tenantId,
            actorId: operator.id,
            actorEmail: operator.email,
            action: 'device.hub_designated',
            reason,
            occurredAt: new Date(),
          },
        })

        return { device: toDeviceView(updated), displacedDeviceId: priorHub?.id ?? null }
      })
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundException({ code: 'not_found', message: 'No such device' })
      throw error
    }
  }

  async revoke(operator: OpsPrincipal, deviceId: string, reason: string): Promise<{ device: DeviceView }> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    try {
      return await plane.$transaction(async (tx) => {
        await setOperatorContext(tx)
        const device = await tx.device.findUnique({ where: { id: deviceId } })
        if (!device) throw new NotFoundException({ code: 'not_found', message: 'No such device' })
        if (device.status === 'revoked') throw new ConflictException({ code: 'conflict', message: 'This device is already revoked' })

        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${device.tenantId}, true)`

        // Revocation is immediate and never deletes (SPEC success criterion):
        // status flips, the row and its history stay. Any op queued for this
        // device routes to sync_dead_letters (AD-7) once an outbox/queued-ops
        // source exists to drain - none does yet this early, so there is
        // nothing to route; the table and its RLS posture are proven by the
        // sync-dead-letters e2e coverage.
        const updated = await tx.device.update({
          where: { id: deviceId },
          data: { status: 'revoked', revokedAt: new Date() },
        })
        await tx.auditEvent.create({
          data: {
            tenantId: device.tenantId,
            actorId: operator.id,
            actorEmail: operator.email,
            action: 'device.revoked',
            reason,
            occurredAt: new Date(),
          },
        })

        return { device: toDeviceView(updated) }
      })
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundException({ code: 'not_found', message: 'No such device' })
      throw error
    }
  }
}
