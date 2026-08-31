// CAP-5 subscription operations. Plan and billing period stay on Tenant
// (existing field, AD-9 note); this service owns the state a subscription
// actually transitions through - active/arrears/suspended - in the region
// plane, same audited-mutation pattern as the tenant directory service.
// Suspension never touches the control-plane registry (AD-9): existence and
// region live there, state lives here.
//
// No subscription row exists until the first mutation (same "absent row =
// platform default" posture as tenant_capabilities): a plain read computes
// the default in memory rather than writing on a GET.
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma, PrismaClient } from '../../generated/prisma/client'
import { OpsPrincipal, PrismaService, RegionRegistryService } from '../../platform'

const GRACE_WINDOW_HOURS_DEFAULT = 72

export interface SubscriptionView {
  tenantId: string
  status: string
  plan: string
  billingPeriod: string
  currentPeriodStart: string
  currentPeriodEnd: string
  suspendedAt: string | null
  graceWindowHours: number
}

export interface InvoiceView {
  id: string
  period: string
  amountMinor: string
  status: string
  createdAt: string
}

type SubRow = { status: string; currentPeriodStart: Date; currentPeriodEnd: Date; suspendedAt: Date | null }
type TenantRow = { id: string; plan: string; billingPeriod: string }

/** Read fresh on every call - never cached, never hardcoded (SPEC: config, not policy). */
function graceWindowHours(): number {
  const raw = process.env.SUSPENSION_GRACE_HOURS
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GRACE_WINDOW_HOURS_DEFAULT
}

function periodLengthMs(billingPeriod: string): number {
  const DAY_MS = 24 * 3_600_000
  return billingPeriod === 'annual' ? 365 * DAY_MS : 30 * DAY_MS
}

function defaultSubRow(tenant: TenantRow, now = new Date()): SubRow {
  return {
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + periodLengthMs(tenant.billingPeriod)),
    suspendedAt: null,
  }
}

function toView(sub: SubRow, tenant: TenantRow): SubscriptionView {
  return {
    tenantId: tenant.id,
    status: sub.status,
    plan: tenant.plan,
    billingPeriod: tenant.billingPeriod,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    suspendedAt: sub.suspendedAt ? sub.suspendedAt.toISOString() : null,
    graceWindowHours: graceWindowHours(),
  }
}

async function setOperatorContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

function isRecordNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2025'
}

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RegionRegistryService,
  ) {}

  async get(tenantId: string): Promise<SubscriptionView> {
    const { plane } = await this.resolvePlane(tenantId)
    return plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      const tenant = await this.requireTenant(tx, tenantId)
      const sub = (await tx.subscription.findUnique({ where: { tenantId } })) ?? defaultSubRow(tenant)
      return toView(sub, tenant)
    })
  }

  async listInvoices(tenantId: string): Promise<{ invoices: InvoiceView[] }> {
    const { plane } = await this.resolvePlane(tenantId)
    const invoices = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      await this.requireTenant(tx, tenantId)
      return tx.invoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } })
    })
    return {
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        period: invoice.period,
        amountMinor: invoice.amountMinor.toString(),
        status: invoice.status,
        createdAt: invoice.createdAt.toISOString(),
      })),
    }
  }

  async suspend(operator: OpsPrincipal, tenantId: string, reason: string): Promise<{ subscription: SubscriptionView }> {
    const subscription = await this.mutate(operator, tenantId, 'subscription.suspended', reason, async (tx, tenant, sub) => {
      if (sub.status === 'suspended') {
        throw new ConflictException({ code: 'conflict', message: 'This subscription is already suspended' })
      }
      const updated = await this.persistSubscription(tx, tenant, sub, { status: 'suspended', suspendedAt: new Date() })
      return toView(updated, tenant)
    })
    return { subscription }
  }

  async reactivate(operator: OpsPrincipal, tenantId: string, reason: string): Promise<{ subscription: SubscriptionView }> {
    const subscription = await this.mutate(operator, tenantId, 'subscription.reactivated', reason, async (tx, tenant, sub) => {
      if (sub.status !== 'suspended') {
        throw new ConflictException({ code: 'conflict', message: 'This subscription is not suspended' })
      }
      const updated = await this.persistSubscription(tx, tenant, sub, { status: 'active', suspendedAt: null })
      return toView(updated, tenant)
    })
    return { subscription }
  }

  /**
   * Runs `work` and the audit_events insert in ONE transaction on the
   * tenant's owning plane, under the tenant RLS context (AD-6, AD-8) - same
   * pattern as TenantDirectoryService.mutate.
   */
  private async mutate<T>(
    operator: OpsPrincipal,
    tenantId: string,
    action: string,
    reason: string,
    work: (tx: Prisma.TransactionClient, tenant: TenantRow, sub: SubRow) => Promise<T>,
  ): Promise<T> {
    const { plane } = await this.resolvePlane(tenantId)
    try {
      return await plane.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        await setOperatorContext(tx)
        const tenant = await this.requireTenant(tx, tenantId)
        const sub = (await tx.subscription.findUnique({ where: { tenantId } })) ?? defaultSubRow(tenant)
        const result = await work(tx, tenant, sub)
        await tx.auditEvent.create({
          data: { tenantId, actorId: operator.id, actorEmail: operator.email, action, reason, occurredAt: new Date() },
        })
        return result
      })
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      throw error
    }
  }

  /** Upserts the (possibly still-virtual) subscription row with a state patch, under the tenant RLS context the caller already set. */
  private async persistSubscription(
    tx: Prisma.TransactionClient,
    tenant: TenantRow,
    sub: SubRow,
    patch: Partial<Pick<SubRow, 'status' | 'suspendedAt'>>,
  ): Promise<SubRow> {
    const merged = { ...sub, ...patch }
    return tx.subscription.upsert({
      where: { tenantId: tenant.id },
      create: {
        tenantId: tenant.id,
        status: merged.status as Prisma.SubscriptionCreateInput['status'],
        currentPeriodStart: merged.currentPeriodStart,
        currentPeriodEnd: merged.currentPeriodEnd,
        suspendedAt: merged.suspendedAt,
      },
      update: { status: merged.status as Prisma.SubscriptionUpdateInput['status'], suspendedAt: merged.suspendedAt },
    })
  }

  private async requireTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantRow> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, plan: true, billingPeriod: true },
    })
    if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
    return tenant
  }

  /** Existence lives in the control-plane registry (AD-9); reads/writes route to the region it names (AD-1). */
  private async resolvePlane(tenantId: string): Promise<{ region: string; plane: PrismaClient }> {
    const entry = await this.prisma.client.tenantRegistryEntry.findUnique({ where: { tenantId } })
    if (!entry || entry.lifecycle === 'deleted') {
      throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
    }
    return { region: entry.region, plane: this.registry.planeFor(entry.region) }
  }
}
