// The tenant directory (CAP-3): cross-tenant list + detail reads under the
// explicit operator RLS context, and detail mutations that write their
// audit_events row in the same transaction (AD-6), routed to the tenant's
// owning region through the registry (AD-1).
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type { Prisma, PrismaClient } from '../../generated/prisma/client'
import { OpsPrincipal, PrismaService, RegionRegistryService } from '../../platform'
import {
  CAPABILITY_DEFAULTS,
  CAPABILITY_KEYS,
  CapabilityKey,
  ToggleCapabilityDto,
  UpdateBrandingDto,
  UpdateTenantDto,
} from './directory.dtos'
import { OWNER_INVITE_TTL_HOURS } from './tenants.service'

const STATUSES = ['provisioning', 'active'] as const
const COUNTRIES = ['IN', 'AU'] as const
const PLANS = ['standard', 'enterprise'] as const
const HEALTHS = ['healthy', 'lagging', 'silent', 'unknown'] as const
const SORTS = ['createdAt', 'name'] as const
const ORDERS = ['asc', 'desc'] as const

const LIMIT_DEFAULT = 25
const LIMIT_MAX = 100
const BRANDING_MAX_TOKENS = 32
const BRANDING_KEY = /^[a-z0-9_.-]{1,64}$/i

const KPI_KEYS = ['active_tenants', 'outlets', 'devices_online', 'open_dlq'] as const
type KpiKey = (typeof KPI_KEYS)[number]

export interface TenantListItem {
  id: string
  name: string
  country: string
  status: string
  plan: string
  outletCount: number
  /** Derived sync health arrives with fleet telemetry; until then: unknown. */
  health: 'unknown'
  createdAt: string
}

export interface TenantListResult {
  tenants: TenantListItem[]
  nextCursor: string | null
  total: number
}

export interface InviteView {
  email: string
  firstName: string
  lastName: string
  status: 'pending' | 'expired'
  expiresAt: string
  createdAt: string
}

export interface TenantDetail {
  tenant: {
    id: string
    name: string
    registeredAddress: string
    contactName: string
    contactEmail: string
    contactPhone: string
    country: string
    status: string
    plan: string
    billingPeriod: string
    brandingTokens: Record<string, string>
    region: string
    createdAt: string
  }
  taxRegistrations: Array<{
    registrationType: string
    registrationNumber: string
    legalEntityName: string
    taxProfile: string
    fssaiLicense: string | null
    compositionScheme: boolean
  }>
  brands: Array<{ id: string; name: string }>
  outlets: Array<{ id: string; name: string; brandId: string; brandName: string; address: string; type: string; timezone: string }>
  rolesCount: number
  ownerInvite: InviteView | null
  capabilities: Array<{ key: CapabilityKey; enabled: boolean }>
}

interface Cursor {
  v: string
  id: string
}

function badRequest(message: string): never {
  throw new BadRequestException({ code: 'validation_failed', message })
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

@Injectable()
export class TenantDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RegionRegistryService,
  ) {}

  // --- Reads: fan out across region planes via the registry (AD-1). v1 has a
  // single plane, so the fan-out is a loop of one.

  async list(query: Record<string, string | undefined>): Promise<TenantListResult> {
    const status = parseChoice(query.status, STATUSES, 'status')
    const country = parseChoice(query.country, COUNTRIES, 'country')
    const plan = parseChoice(query.plan, PLANS, 'plan')
    const health = parseChoice(query.health, HEALTHS, 'health')
    const sort = parseChoice(query.sort, SORTS, 'sort') ?? 'createdAt'
    const order = parseChoice(query.order, ORDERS, 'order') ?? (sort === 'createdAt' ? 'desc' : 'asc')
    const limit = query.limit === undefined ? LIMIT_DEFAULT : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) badRequest(`limit must be an integer between 1 and ${LIMIT_MAX}`)
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)

    // No telemetry exists yet, so every tenant's health is "unknown": any
    // other health filter cannot match.
    if (health !== undefined && health !== 'unknown') return { tenants: [], nextCursor: null, total: 0 }

    const where: Prisma.TenantWhereInput = {
      deletedAt: null,
      ...(status && { status }),
      ...(country && { country }),
      ...(plan && { plan }),
      ...(query.q && { name: { contains: query.q, mode: 'insensitive' } }),
    }
    if (cursor) {
      const op = order === 'desc' ? 'lt' : 'gt'
      const value = sort === 'createdAt' ? new Date(cursor.v) : cursor.v
      where.AND = [
        {
          OR: [{ [sort]: { [op]: value } }, { [sort]: value, id: { [op]: cursor.id } }],
        },
      ]
    }

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const [rows, total] = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      return Promise.all([
        tx.tenant.findMany({
          where,
          orderBy: [{ [sort]: order }, { id: order }],
          take: limit + 1,
          select: {
            id: true,
            name: true,
            country: true,
            status: true,
            plan: true,
            createdAt: true,
            _count: { select: { outlets: { where: { deletedAt: null } } } },
          },
        }),
        tx.tenant.count({ where: { ...where, AND: undefined } }),
      ])
    })

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ v: sort === 'createdAt' ? last.createdAt.toISOString() : last.name, id: last.id })
        : null

    return {
      tenants: page.map((row) => ({
        id: row.id,
        name: row.name,
        country: row.country,
        status: row.status,
        plan: row.plan,
        outletCount: row._count.outlets,
        health: 'unknown',
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor,
      total,
    }
  }

  async detail(id: string): Promise<TenantDetail> {
    const { region, plane } = await this.resolvePlane(id)
    const result = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      const tenant = await tx.tenant.findUnique({
        where: { id, deletedAt: null },
        include: {
          taxRegistrations: true,
          brands: { orderBy: { createdAt: 'asc' } },
          outlets: { where: { deletedAt: null }, include: { brand: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
          capabilities: true,
          ownerInvites: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count: { select: { roles: true } },
        },
      })
      return tenant
    })
    if (!result) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })

    const overrides = new Map(result.capabilities.map((c) => [c.key, c.enabled]))
    const invite = result.ownerInvites[0]

    return {
      tenant: {
        id: result.id,
        name: result.name,
        registeredAddress: result.registeredAddress,
        contactName: result.contactName,
        contactEmail: result.contactEmail,
        contactPhone: result.contactPhone,
        country: result.country,
        status: result.status,
        plan: result.plan,
        billingPeriod: result.billingPeriod,
        brandingTokens: result.brandingTokens as Record<string, string>,
        region,
        createdAt: result.createdAt.toISOString(),
      },
      taxRegistrations: result.taxRegistrations.map((r) => ({
        registrationType: r.registrationType,
        registrationNumber: r.registrationNumber,
        legalEntityName: r.legalEntityName,
        taxProfile: r.taxProfile,
        fssaiLicense: r.fssaiLicense,
        compositionScheme: r.compositionScheme,
      })),
      brands: result.brands.map((b) => ({ id: b.id, name: b.name })),
      outlets: result.outlets.map((o) => ({
        id: o.id,
        name: o.name,
        brandId: o.brandId,
        brandName: o.brand.name,
        address: o.address,
        type: o.type,
        timezone: o.timezone,
      })),
      rolesCount: result._count.roles,
      ownerInvite: invite
        ? {
            email: invite.email,
            firstName: invite.firstName,
            lastName: invite.lastName,
            status: invite.expiresAt.getTime() > Date.now() ? 'pending' : 'expired',
            expiresAt: invite.expiresAt.toISOString(),
            createdAt: invite.createdAt.toISOString(),
          }
        : null,
      capabilities: CAPABILITY_KEYS.map((key) => ({ key, enabled: overrides.get(key) ?? CAPABILITY_DEFAULTS[key] })),
    }
  }

  async kpi(key: string): Promise<{ key: KpiKey; value: number }> {
    if (!(KPI_KEYS as readonly string[]).includes(key)) badRequest(`key must be one of: ${KPI_KEYS.join(', ')}`)
    const kpiKey = key as KpiKey
    // Device and DLQ counts read 0 until their fleet stories add the data.
    if (kpiKey === 'devices_online' || kpiKey === 'open_dlq') return { key: kpiKey, value: 0 }

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const value = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      return kpiKey === 'active_tenants'
        ? tx.tenant.count({ where: { status: 'active', deletedAt: null } })
        : tx.outlet.count({ where: { deletedAt: null } })
    })
    return { key: kpiKey, value }
  }

  // --- Mutations: one transaction each - the write and its audit_events row
  // commit or roll back together (AD-6).

  async updateBasics(operator: OpsPrincipal, id: string, dto: UpdateTenantDto): Promise<{ tenant: { id: string; name: string } }> {
    const data: Prisma.TenantUpdateInput = {}
    if (dto.name !== undefined) data.name = dto.name
    if (dto.registeredAddress !== undefined) data.registeredAddress = dto.registeredAddress
    if (dto.contactName !== undefined) data.contactName = dto.contactName
    if (dto.contactEmail !== undefined) data.contactEmail = dto.contactEmail
    if (dto.contactPhone !== undefined) data.contactPhone = dto.contactPhone
    if (Object.keys(data).length === 0) badRequest('Nothing to update - provide at least one field')

    const updated = await this.mutate(operator, id, 'tenant.updated', dto.reason, async (tx) => {
      return tx.tenant.update({ where: { id }, data, select: { id: true, name: true } })
    })
    return { tenant: updated }
  }

  async toggleCapability(
    operator: OpsPrincipal,
    id: string,
    key: string,
    dto: ToggleCapabilityDto,
  ): Promise<{ capability: { key: CapabilityKey; enabled: boolean } }> {
    if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) {
      badRequest(`key must be one of: ${CAPABILITY_KEYS.join(', ')}`)
    }
    const capKey = key as CapabilityKey
    const action = `tenant.capability.${capKey}.${dto.enabled ? 'enabled' : 'disabled'}`
    await this.mutate(operator, id, action, dto.reason, async (tx) => {
      await tx.tenantCapability.upsert({
        where: { tenantId_key: { tenantId: id, key: capKey } },
        create: { tenantId: id, key: capKey, enabled: dto.enabled },
        update: { enabled: dto.enabled },
      })
    })
    return { capability: { key: capKey, enabled: dto.enabled } }
  }

  async updateBranding(
    operator: OpsPrincipal,
    id: string,
    dto: UpdateBrandingDto,
  ): Promise<{ brandingTokens: Record<string, string> }> {
    const entries = Object.entries(dto.tokens)
    if (entries.length > BRANDING_MAX_TOKENS) badRequest(`tokens may hold at most ${BRANDING_MAX_TOKENS} entries`)
    for (const [tokenKey, value] of entries) {
      if (!BRANDING_KEY.test(tokenKey)) badRequest(`token key "${tokenKey}" is not a valid token name`)
      if (typeof value !== 'string' || value.length > 500) badRequest(`token "${tokenKey}" must be a string of at most 500 characters`)
    }
    const tokens = Object.fromEntries(entries) as Record<string, string>

    await this.mutate(operator, id, 'tenant.branding_updated', dto.reason, async (tx) => {
      await tx.tenant.update({ where: { id }, data: { brandingTokens: tokens } })
    })
    return { brandingTokens: tokens }
  }

  // inviteToken is the raw accept token, exposed exactly once here: there is
  // no mailer in this prototype, so the ops console must be able to show a
  // copyable accept link (issue #85). Only the hash is stored.
  async regenerateOwnerInvite(
    operator: OpsPrincipal,
    id: string,
    reason: string,
  ): Promise<{ invite: InviteView; inviteToken: string }> {
    const rawToken = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + OWNER_INVITE_TTL_HOURS * 3_600_000)

    const invite = await this.mutate(operator, id, 'tenant.owner_invite_regenerated', reason, async (tx) => {
      const existing = await tx.ownerInvite.findFirst({ where: { tenantId: id }, orderBy: { createdAt: 'desc' } })
      if (!existing) throw new NotFoundException({ code: 'not_found', message: 'This tenant has no owner invite to regenerate' })
      // The old token must stop working the moment the new one exists.
      await tx.ownerInvite.deleteMany({ where: { tenantId: id } })
      return tx.ownerInvite.create({
        data: {
          tenantId: id,
          email: existing.email,
          firstName: existing.firstName,
          lastName: existing.lastName,
          tokenHash: createHash('sha256').update(rawToken).digest('hex'),
          expiresAt,
        },
      })
    })

    return {
      invite: {
        email: invite.email,
        firstName: invite.firstName,
        lastName: invite.lastName,
        status: 'pending',
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      },
      inviteToken: rawToken,
    }
  }

  async activate(operator: OpsPrincipal, id: string, reason: string): Promise<{ tenant: { id: string; status: string } }> {
    const tenant = await this.mutate(operator, id, 'tenant.activated', reason, async (tx) => {
      const current = await tx.tenant.findUnique({ where: { id }, select: { status: true } })
      if (current?.status !== 'provisioning') {
        throw new ConflictException({ code: 'conflict', message: 'Only a provisioning tenant can be activated' })
      }
      return tx.tenant.update({ where: { id }, data: { status: 'active' }, select: { id: true, status: true } })
    })
    return { tenant }
  }

  /**
   * Runs `work` and the audit_events insert in ONE transaction on the
   * tenant's owning plane, under the tenant RLS context.
   */
  private async mutate<T>(
    operator: OpsPrincipal,
    tenantId: string,
    action: string,
    reason: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const { plane } = await this.resolvePlane(tenantId)
    try {
      return await plane.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        const exists = await tx.tenant.findUnique({ where: { id: tenantId, deletedAt: null }, select: { id: true } })
        if (!exists) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
        const result = await work(tx)
        await tx.auditEvent.create({
          data: {
            tenantId,
            actorId: operator.id,
            actorEmail: operator.email,
            action,
            reason,
            occurredAt: new Date(),
          },
        })
        return result
      })
    } catch (error) {
      // An RLS-blocked write surfaces as a Prisma known error; the row simply
      // does not exist as far as this operator is concerned.
      if (isRecordNotFound(error)) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      throw error
    }
  }

  /**
   * Existence lives in the control-plane registry (AD-9); every read and
   * write is routed to the owning region it names (AD-1).
   */
  private async resolvePlane(tenantId: string): Promise<{ region: string; plane: PrismaClient }> {
    const entry = await this.prisma.client.tenantRegistryEntry.findUnique({ where: { tenantId } })
    if (!entry || entry.lifecycle === 'deleted') {
      throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
    }
    return { region: entry.region, plane: this.registry.planeFor(entry.region) }
  }
}

async function setOperatorContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

function isRecordNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2025'
}
