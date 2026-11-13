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
//
// #282 card billing: the owner enters a card once in Stripe Checkout (platform
// account, mode=subscription); Stripe webhooks then keep cardBillingStatus,
// invoices and arrears in step (applyStripeEvent).
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type Stripe from 'stripe'
import type { CardBillingStatus, Prisma, PrismaClient } from '../../generated/prisma/client'
import { OpsPrincipal, PrismaService, RegionRegistryService, StripeService } from '../../platform'
import { doneUrl } from '../payments/payments.service'

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
  cardBilling: {
    status: 'not_set_up' | CardBillingStatus
    amountMinor: string | null
    currency: 'AUD' | 'INR'
  }
}

export interface InvoiceView {
  id: string
  period: string
  amountMinor: string
  status: string
  createdAt: string
}

type SubRow = {
  status: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  suspendedAt: Date | null
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  cardBillingStatus: CardBillingStatus | null
}
type TenantRow = { id: string; name: string; contactEmail: string; country: 'AU' | 'IN'; plan: 'standard' | 'enterprise'; billingPeriod: string; slug: string | null }
type Price = { monthlyPriceMinor: bigint | null; annualDiscountPercent: number } | null
type SubPatch = Partial<Pick<SubRow, 'status' | 'suspendedAt' | 'stripeCustomerId' | 'stripeSubscriptionId' | 'cardBillingStatus'>>

const CURRENCY = { AU: 'AUD', IN: 'INR' } as const

/** What one billing period charges: the monthly list price, or 12 months less the annual discount (rounded half up). */
export function periodAmountMinor(monthlyPriceMinor: bigint, billingPeriod: string, annualDiscountPercent: number): bigint {
  if (billingPeriod !== 'annual') return monthlyPriceMinor
  return (monthlyPriceMinor * 12n * BigInt(100 - annualDiscountPercent) + 50n) / 100n
}

/** Stripe subscription status -> cardBillingStatus. Incomplete/trialing/paused stay pending. */
export function cardBillingFromStripe(status: Stripe.Subscription.Status): CardBillingStatus {
  const known: Partial<Record<string, CardBillingStatus>> = { active: 'active', past_due: 'past_due', canceled: 'canceled' }
  return known[status] ?? 'pending'
}

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
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    cardBillingStatus: null,
  }
}

function toView(sub: SubRow, tenant: TenantRow, price: Price): SubscriptionView {
  return {
    tenantId: tenant.id,
    status: sub.status,
    plan: tenant.plan,
    billingPeriod: tenant.billingPeriod,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    suspendedAt: sub.suspendedAt ? sub.suspendedAt.toISOString() : null,
    graceWindowHours: graceWindowHours(),
    cardBilling: {
      status: sub.cardBillingStatus ?? 'not_set_up',
      amountMinor: price?.monthlyPriceMinor == null ? null : periodAmountMinor(price.monthlyPriceMinor, tenant.billingPeriod, price.annualDiscountPercent).toString(),
      currency: CURRENCY[tenant.country],
    },
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
  private readonly logger = new Logger(SubscriptionsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RegionRegistryService,
    private readonly stripe: StripeService,
  ) {}

  async get(tenantId: string): Promise<SubscriptionView> {
    const { tenant, sub } = await this.read(tenantId)
    return toView(sub, tenant, await this.planPrice(tenant))
  }

  /**
   * A Stripe Checkout link (mode=subscription, platform account) where the owner
   * enters a card once; Stripe then charges it every period. The price is inline
   * from PlanPrice, so a price edit applies to the next link, not live subscriptions.
   */
  async billingLink(tenantId: string): Promise<{ url: string; expiresAt: string }> {
    const stripe = this.stripe.client()
    const { tenant, sub } = await this.read(tenantId)
    if (sub.cardBillingStatus === 'active') {
      throw new ConflictException({ code: 'conflict', message: 'Card billing is already active for this tenant' })
    }
    const price = await this.planPrice(tenant)
    if (price?.monthlyPriceMinor == null) {
      throw new ConflictException({ code: 'price_not_set', message: `No monthly price is set for the ${tenant.country} ${tenant.plan} plan` })
    }
    const customerId =
      sub.stripeCustomerId ??
      (
        await stripe.customers.create(
          { name: tenant.name, email: tenant.contactEmail, metadata: { tenantId } },
          { idempotencyKey: `restiq-billing-customer-${tenantId}` },
        )
      ).id
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      // Bill in the restaurant's own currency, never converted to the visitor's local one.
      adaptive_pricing: { enabled: false },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY[tenant.country].toLowerCase(),
            unit_amount: Number(periodAmountMinor(price.monthlyPriceMinor, tenant.billingPeriod, price.annualDiscountPercent)),
            recurring: { interval: tenant.billingPeriod === 'annual' ? 'year' : 'month' },
            product_data: { name: `Restiq ${tenant.plan} plan (${tenant.billingPeriod})` },
          },
        },
      ],
      metadata: { tenantId },
      subscription_data: { metadata: { tenantId } },
      success_url: doneUrl(tenant, 'billing'),
      cancel_url: `${doneUrl(tenant, 'billing')}&cancelled=1`,
    })
    await this.write(tenantId, (tx, tenant, sub) =>
      this.persistSubscription(tx, tenant, sub, { stripeCustomerId: customerId, cardBillingStatus: 'pending' }),
    )
    if (!session.url) throw new Error('Stripe returned a Checkout Session without a URL')
    return { url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() }
  }

  /**
   * Applies one verified Stripe webhook event. Redeliveries are safe: invoices
   * upsert on their Stripe id, statuses are set (not toggled). Events this
   * platform does not act on, or that name no known tenant, are ignored.
   */
  async applyStripeEvent(event: Stripe.Event): Promise<'applied' | 'ignored'> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const tenantId = session.metadata?.tenantId
        if (session.mode !== 'subscription' || !tenantId) return 'ignored'
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null)
        const customerId = typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null)
        return this.applyFor(tenantId, (tx, tenant, sub) =>
          this.persistSubscription(tx, tenant, sub, {
            stripeSubscriptionId: subscriptionId,
            stripeCustomerId: customerId ?? sub.stripeCustomerId,
            cardBillingStatus: 'active',
          }),
        )
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const tenantId = await this.invoiceTenantId(invoice)
        if (!tenantId || !invoice.id) return 'ignored'
        const paid = event.type === 'invoice.paid'
        return this.applyFor(tenantId, async (tx, tenant, sub) => {
          // Card billing never lifts or replaces an operator's suspension.
          const status = sub.status === 'suspended' ? 'suspended' : paid ? 'active' : 'arrears'
          const saved = await this.persistSubscription(tx, tenant, sub, { status })
          const fields = {
            period: new Date(invoice.period_start * 1000).toISOString().slice(0, 7),
            amountMinor: BigInt(paid ? invoice.amount_paid : invoice.amount_due),
            status: paid ? ('paid' as const) : ('overdue' as const),
          }
          await tx.invoice.upsert({
            where: { stripeInvoiceId: invoice.id },
            create: { tenantId, subscriptionId: saved.id, stripeInvoiceId: invoice.id, ...fields },
            update: fields,
          })
        })
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        const tenantId = subscription.metadata?.tenantId
        if (!tenantId) return 'ignored'
        return this.applyFor(tenantId, async (tx, tenant, sub) => {
          // An event for a subscription this tenant has since replaced must not overwrite the new one's state.
          if (sub.stripeSubscriptionId && sub.stripeSubscriptionId !== subscription.id) return
          await this.persistSubscription(tx, tenant, sub, {
            stripeSubscriptionId: subscription.id,
            cardBillingStatus: cardBillingFromStripe(subscription.status),
          })
        })
      }
      default:
        return 'ignored'
    }
  }

  private async invoiceTenantId(invoice: Stripe.Invoice): Promise<string | undefined> {
    const details = invoice.parent?.subscription_details
    if (!details) return undefined
    const fromSnapshot = details.metadata?.tenantId
    if (fromSnapshot) return fromSnapshot
    const subscription = typeof details.subscription === 'string' ? await this.stripe.client().subscriptions.retrieve(details.subscription) : details.subscription
    return subscription.metadata?.tenantId
  }

  /** Webhook writes: an unknown or deleted tenant is acknowledged and ignored, so Stripe stops retrying it. */
  private async applyFor(tenantId: string, work: (tx: Prisma.TransactionClient, tenant: TenantRow, sub: SubRow) => Promise<unknown>): Promise<'applied' | 'ignored'> {
    try {
      await this.write(tenantId, work)
      return 'applied'
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.warn(`Stripe event for unknown tenant ${tenantId} ignored`)
        return 'ignored'
      }
      throw error
    }
  }

  private async read(tenantId: string): Promise<{ tenant: TenantRow; sub: SubRow }> {
    const { plane } = await this.resolvePlane(tenantId)
    return plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      const tenant = await this.requireTenant(tx, tenantId)
      const sub = (await tx.subscription.findUnique({ where: { tenantId } })) ?? defaultSubRow(tenant)
      return { tenant, sub }
    })
  }

  /** Unaudited system write (webhooks, billing-link bookkeeping) under the tenant RLS context. */
  private async write<T>(tenantId: string, work: (tx: Prisma.TransactionClient, tenant: TenantRow, sub: SubRow) => Promise<T>): Promise<T> {
    const { plane } = await this.resolvePlane(tenantId)
    return plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      await setOperatorContext(tx)
      const tenant = await this.requireTenant(tx, tenantId)
      const sub = (await tx.subscription.findUnique({ where: { tenantId } })) ?? defaultSubRow(tenant)
      return work(tx, tenant, sub)
    })
  }

  /** PlanPrice lives on the home region plane only (#201). */
  private planPrice(tenant: TenantRow): Promise<Price> {
    return this.registry
      .planeFor(this.registry.homeRegion())
      .planPrice.findUnique({ where: { country_plan: { country: tenant.country, plan: tenant.plan } } })
  }

  async listInvoices(tenantId: string): Promise<{ invoices: InvoiceView[] }> {
    const { plane } = await this.resolvePlane(tenantId)
    const invoices = await plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      await this.requireTenant(tx, tenantId)
      return tx.invoice.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'desc' }, { period: 'desc' }] })
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
    const result = await this.mutate(operator, tenantId, 'subscription.suspended', reason, async (tx, tenant, sub) => {
      if (sub.status === 'suspended') {
        throw new ConflictException({ code: 'conflict', message: 'This subscription is already suspended' })
      }
      return { tenant, sub: await this.persistSubscription(tx, tenant, sub, { status: 'suspended', suspendedAt: new Date() }) }
    })
    return { subscription: toView(result.sub, result.tenant, await this.planPrice(result.tenant)) }
  }

  async reactivate(operator: OpsPrincipal, tenantId: string, reason: string): Promise<{ subscription: SubscriptionView }> {
    const result = await this.mutate(operator, tenantId, 'subscription.reactivated', reason, async (tx, tenant, sub) => {
      if (sub.status !== 'suspended') {
        throw new ConflictException({ code: 'conflict', message: 'This subscription is not suspended' })
      }
      return { tenant, sub: await this.persistSubscription(tx, tenant, sub, { status: 'active', suspendedAt: null }) }
    })
    return { subscription: toView(result.sub, result.tenant, await this.planPrice(result.tenant)) }
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
    patch: SubPatch,
  ): Promise<SubRow & { id: string }> {
    const merged = { ...sub, ...patch }
    const state = {
      status: merged.status as Prisma.SubscriptionCreateInput['status'],
      suspendedAt: merged.suspendedAt,
      stripeCustomerId: merged.stripeCustomerId,
      stripeSubscriptionId: merged.stripeSubscriptionId,
      cardBillingStatus: merged.cardBillingStatus,
    }
    return tx.subscription.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, currentPeriodStart: merged.currentPeriodStart, currentPeriodEnd: merged.currentPeriodEnd, ...state },
      update: state,
    })
  }

  private async requireTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantRow> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, name: true, contactEmail: true, country: true, plan: true, billingPeriod: true, slug: true },
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
