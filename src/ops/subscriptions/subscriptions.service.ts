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
//
// #290 billing contract: typed line items per tenant. While a tenant has unbilled
// items they replace the plan price (billingLink, cardBilling.amountMinor); a save
// while card billing is active is pushed to the live Stripe subscription.
import { createHash } from 'node:crypto'
import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type Stripe from 'stripe'
import type { BillingLineItem, CardBillingStatus, Prisma, PrismaClient } from '../../generated/prisma/client'
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

export interface ContractItemInput {
  description: string
  quantity: number
  unitAmountMinor: number
  kind: 'recurring' | 'one_time'
}

export interface ContractView {
  currency: 'AUD' | 'INR'
  billingPeriod: 'monthly' | 'annual'
  items: Array<ContractItemInput & { id: string; billedAt: string | null }>
  source: 'contract' | 'plan'
  recurringTotalMinor: string | null
  nextInvoiceOneTimeMinor: string
  planAmountMinor: string | null
  appliesFromNextInvoice: boolean
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
// Stripe metadata values are capped at 500 characters.
const METADATA_MAX = 500
// Stripe allows at most 20 items on one subscription.
const MAX_RECURRING_ITEMS = 20

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

function planAmount(tenant: TenantRow, price: Price): bigint | null {
  return price?.monthlyPriceMinor == null ? null : periodAmountMinor(price.monthlyPriceMinor, tenant.billingPeriod, price.annualDiscountPercent)
}

function lineTotal(item: BillingLineItem): bigint {
  return BigInt(item.quantity) * item.unitAmountMinor
}

function sum(items: BillingLineItem[]): bigint {
  return items.reduce((total, item) => total + lineTotal(item), 0n)
}

/** Recurring contract items, or null when there are none (the plan price applies). */
function recurringTotal(items: BillingLineItem[]): bigint | null {
  const recurring = items.filter((item) => item.kind === 'recurring')
  return recurring.length ? sum(recurring) : null
}

function interval(tenant: TenantRow): 'year' | 'month' {
  return tenant.billingPeriod === 'annual' ? 'year' : 'month'
}

function toView(sub: SubRow, tenant: TenantRow, price: Price, items: BillingLineItem[]): SubscriptionView {
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
      amountMinor: (recurringTotal(items) ?? planAmount(tenant, price))?.toString() ?? null,
      currency: CURRENCY[tenant.country],
    },
  }
}

async function setOperatorContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

function toContractView(sub: SubRow, tenant: TenantRow, price: Price, items: BillingLineItem[]): ContractView {
  const unbilled = items.filter((item) => !item.billedAt)
  const plan = planAmount(tenant, price)
  const source = unbilled.length ? 'contract' : 'plan'
  return {
    currency: CURRENCY[tenant.country],
    billingPeriod: tenant.billingPeriod === 'annual' ? 'annual' : 'monthly',
    // items arrive in sortOrder; billed one-time items go last.
    items: [...unbilled, ...items.filter((item) => item.billedAt)].map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      unitAmountMinor: Number(item.unitAmountMinor),
      kind: item.kind,
      billedAt: item.billedAt ? item.billedAt.toISOString() : null,
    })),
    source,
    // With no recurring line the plan price is what Stripe charges (syncStripe/billingLink fall back to it).
    recurringTotalMinor: (recurringTotal(items) ?? plan)?.toString() ?? null,
    nextInvoiceOneTimeMinor: sum(unbilled.filter((item) => item.kind === 'one_time')).toString(),
    planAmountMinor: plan?.toString() ?? null,
    appliesFromNextInvoice: sub.cardBillingStatus === 'active',
  }
}

function contractItems(tx: Prisma.TransactionClient, tenantId: string): Promise<BillingLineItem[]> {
  return tx.billingLineItem.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
}

/** One-time items are billed once: only still-unbilled ones are stamped, so a redelivery changes nothing. */
async function markBilled(tx: Prisma.TransactionClient, tenantId: string, ids: string[]): Promise<void> {
  await tx.billingLineItem.updateMany({ where: { tenantId, id: { in: ids }, kind: 'one_time', billedAt: null }, data: { billedAt: new Date() } })
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
    const { tenant, sub, items } = await this.read(tenantId)
    return toView(sub, tenant, await this.planPrice(tenant), items)
  }

  async getContract(tenantId: string): Promise<ContractView> {
    const { tenant, sub, items } = await this.read(tenantId)
    return toContractView(sub, tenant, await this.planPrice(tenant), items)
  }

  /**
   * Replaces every unbilled item (billed one-time items stay), audited. While card
   * billing is active the change is then pushed to the Stripe subscription; if that
   * fails the saved contract stays and the caller gets 502 stripe_sync_failed.
   */
  async saveContract(operator: OpsPrincipal, tenantId: string, input: ContractItemInput[], reason: string): Promise<ContractView> {
    if (input.filter((item) => item.kind === 'recurring').length > MAX_RECURRING_ITEMS) {
      throw new BadRequestException({ code: 'validation_failed', message: `A contract can have at most ${MAX_RECURRING_ITEMS} recurring lines (Stripe's limit per subscription)` })
    }
    const { tenant: current } = await this.read(tenantId)
    const price = await this.planPrice(current)
    const { tenant, sub, items } = await this.mutate(operator, tenantId, 'billing.contract_updated', reason, async (tx, tenant, sub) => {
      const syncs = sub.cardBillingStatus === 'active' && sub.stripeSubscriptionId
      // A live Stripe subscription needs one recurring item: the contract's, or the plan price.
      if (syncs && !input.some((item) => item.kind === 'recurring') && planAmount(tenant, price) == null) {
        throw new ConflictException({ code: 'price_not_set', message: `Card billing is active: add a recurring line, or set a price for the ${tenant.country} ${tenant.plan} plan first` })
      }
      await tx.billingLineItem.deleteMany({ where: { tenantId, billedAt: null } })
      await tx.billingLineItem.createMany({
        data: input.map((item, sortOrder) => ({
          tenantId,
          description: item.description.trim(),
          quantity: item.quantity,
          unitAmountMinor: BigInt(item.unitAmountMinor),
          kind: item.kind,
          sortOrder,
        })),
      })
      return { tenant, sub, items: await contractItems(tx, tenantId) }
    })
    if (sub.cardBillingStatus !== 'active' || !sub.stripeSubscriptionId) return toContractView(sub, tenant, price, items)
    try {
      await this.syncStripe(tenant, sub, price, items)
    } catch (error) {
      this.logger.error(`Billing contract Stripe sync failed for tenant ${tenantId}`, error instanceof Error ? error.stack : String(error))
      const detail = error instanceof Error ? error.message : 'unknown error'
      throw new BadGatewayException({
        code: 'stripe_sync_failed',
        message: `The contract was saved, but Stripe could not be updated (${detail}). Save again to retry.`,
      })
    }
    return this.getContract(tenantId)
  }

  /** Replaces the subscription's recurring items (no proration) and puts new one-time items on the next invoice. */
  private async syncStripe(tenant: TenantRow, sub: SubRow, price: Price, items: BillingLineItem[]): Promise<void> {
    const stripe = this.stripe.client()
    const subscriptionId = sub.stripeSubscriptionId as string
    const currency = CURRENCY[tenant.country].toLowerCase()
    const recurring = items.filter((item) => item.kind === 'recurring')
    const lines = recurring.length
      ? recurring.map((item) => ({ key: item.id, name: item.description, unitAmount: Number(item.unitAmountMinor), quantity: item.quantity }))
      : [{ key: `plan-${tenant.plan}`, name: `Restiq ${tenant.plan} plan (${tenant.billingPeriod})`, unitAmount: Number(planAmount(tenant, price)), quantity: 1 }]
    const newItems: Stripe.SubscriptionUpdateParams.Item[] = []
    for (const line of lines) {
      const product = await stripe.products.create(
        { name: line.name, metadata: { tenantId: tenant.id } },
        { idempotencyKey: `restiq-contract-product-${tenant.id}-${line.key}` },
      )
      newItems.push({ price_data: { currency, product: product.id, unit_amount: line.unitAmount, recurring: { interval: interval(tenant) } }, quantity: line.quantity })
    }
    const existing = await stripe.subscriptions.retrieve(subscriptionId)
    const syncKey = createHash('sha256').update(lines.map((line) => line.key).join(',')).digest('hex').slice(0, 32)
    await stripe.subscriptions.update(
      subscriptionId,
      { items: [...existing.items.data.map((item) => ({ id: item.id, deleted: true })), ...newItems], proration_behavior: 'none' },
      { idempotencyKey: `restiq-contract-sync-${tenant.id}-${syncKey}` },
    )

    const oneTime = items.filter((item) => item.kind === 'one_time' && !item.billedAt)
    if (!oneTime.length) return
    if (!sub.stripeCustomerId) throw new Error('the subscription has no Stripe customer')
    const billed: string[] = []
    try {
      for (const item of oneTime) {
        await stripe.invoiceItems.create(
          { customer: sub.stripeCustomerId, subscription: subscriptionId, currency, amount: Number(lineTotal(item)), description: `${item.description} × ${item.quantity}` },
          { idempotencyKey: `restiq-contract-invoice-item-${tenant.id}-${item.id}` },
        )
        billed.push(item.id)
      }
    } finally {
      // Whatever reached Stripe rides on the next invoice: never offer it again.
      if (billed.length) await this.write(tenant.id, (tx) => markBilled(tx, tenant.id, billed))
    }
  }

  /**
   * A Stripe Checkout link (mode=subscription, platform account) where the owner
   * enters a card once; Stripe then charges it every period. The price is inline
   * from PlanPrice, so a price edit applies to the next link, not live subscriptions.
   */
  async billingLink(tenantId: string): Promise<{ url: string; expiresAt: string }> {
    const stripe = this.stripe.client()
    const { tenant, sub, items } = await this.read(tenantId)
    if (sub.cardBillingStatus === 'active') {
      throw new ConflictException({ code: 'conflict', message: 'Card billing is already active for this tenant' })
    }
    const currency = CURRENCY[tenant.country].toLowerCase()
    const recurring = { interval: interval(tenant) }
    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[]
    let oneTimeItemIds = ''
    const unbilled = items.filter((item) => !item.billedAt)
    if (unbilled.length) {
      // #290 contract: recurring items every period, unbilled one-time items on the first invoice only.
      if (!unbilled.some((item) => item.kind === 'recurring')) {
        throw new ConflictException({ code: 'no_recurring_items', message: 'The billing contract needs at least one recurring line before card billing can start' })
      }
      const oneTime = unbilled.filter((item) => item.kind === 'one_time')
      oneTimeItemIds = oneTime.map((item) => item.id).join(',')
      if (oneTimeItemIds.length > METADATA_MAX) {
        throw new ConflictException({ code: 'too_many_one_time_items', message: 'Too many one-time lines for one checkout: combine some of them' })
      }
      lineItems = unbilled.map((item) => ({
        quantity: item.quantity,
        price_data: {
          currency,
          unit_amount: Number(item.unitAmountMinor),
          ...(item.kind === 'recurring' ? { recurring } : {}),
          product_data: { name: item.description },
        },
      }))
    } else {
      const amount = planAmount(tenant, await this.planPrice(tenant))
      if (amount == null) {
        throw new ConflictException({ code: 'price_not_set', message: `No monthly price is set for the ${tenant.country} ${tenant.plan} plan` })
      }
      lineItems = [{ quantity: 1, price_data: { currency, unit_amount: Number(amount), recurring, product_data: { name: `Restiq ${tenant.plan} plan (${tenant.billingPeriod})` } } }]
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
      line_items: lineItems,
      metadata: oneTimeItemIds ? { tenantId, oneTimeItemIds } : { tenantId },
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
        // #290: the one-time contract items this checkout charged (redelivery only re-marks nothing).
        const oneTimeItemIds = (session.metadata?.oneTimeItemIds ?? '').split(',').filter(Boolean)
        return this.applyFor(tenantId, async (tx, tenant, sub) => {
          await this.persistSubscription(tx, tenant, sub, {
            stripeSubscriptionId: subscriptionId,
            stripeCustomerId: customerId ?? sub.stripeCustomerId,
            cardBillingStatus: 'active',
          })
          if (oneTimeItemIds.length) await markBilled(tx, tenantId, oneTimeItemIds)
        })
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

  private async read(tenantId: string): Promise<{ tenant: TenantRow; sub: SubRow; items: BillingLineItem[] }> {
    const { plane } = await this.resolvePlane(tenantId)
    return plane.$transaction(async (tx) => {
      await setOperatorContext(tx)
      const tenant = await this.requireTenant(tx, tenantId)
      const sub = (await tx.subscription.findUnique({ where: { tenantId } })) ?? defaultSubRow(tenant)
      return { tenant, sub, items: await contractItems(tx, tenantId) }
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
      return { tenant, sub: await this.persistSubscription(tx, tenant, sub, { status: 'suspended', suspendedAt: new Date() }), items: await contractItems(tx, tenantId) }
    })
    return { subscription: toView(result.sub, result.tenant, await this.planPrice(result.tenant), result.items) }
  }

  async reactivate(operator: OpsPrincipal, tenantId: string, reason: string): Promise<{ subscription: SubscriptionView }> {
    const result = await this.mutate(operator, tenantId, 'subscription.reactivated', reason, async (tx, tenant, sub) => {
      if (sub.status !== 'suspended') {
        throw new ConflictException({ code: 'conflict', message: 'This subscription is not suspended' })
      }
      return { tenant, sub: await this.persistSubscription(tx, tenant, sub, { status: 'active', suspendedAt: null }), items: await contractItems(tx, tenantId) }
    })
    return { subscription: toView(result.sub, result.tenant, await this.planPrice(result.tenant), result.items) }
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
