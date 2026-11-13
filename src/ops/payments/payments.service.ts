// #282 restaurant payments: the tenant's Stripe Connect account (Accounts v2) plus
// the platform's settings for it (which wallets are offered, the platform fee).
// Settings live in the tenant's region plane; the account's status is read live
// from Stripe on every view. #284: whether card payments are active is also kept
// on the row (cardPaymentsActive) so guest bill reads never call Stripe.
import { Injectable, NotFoundException } from '@nestjs/common'
import type Stripe from 'stripe'
import type { Prisma, PrismaClient, TenantPaymentAccount } from '../../generated/prisma/client'
import { OpsPrincipal, PrismaService, RegionRegistryService, StripeService } from '../../platform'
import { PaymentMethod, UpdatePaymentsDto } from './payments.dtos'

export type PaymentsStatus = 'not_connected' | 'onboarding' | 'restricted' | 'active'

export interface PaymentsView {
  tenantId: string
  stripeAccountId: string | null
  status: PaymentsStatus
  requirementsDue: number
  cardPaymentsActive: boolean
  payoutsActive: boolean
  detailsSubmitted: boolean
  requirements: PaymentRequirement[]
  allowedMethods: PaymentMethod[]
  feePercentBps: number
  feeFixedMinor: string
  currency: 'AUD' | 'INR'
}

export interface PaymentRequirement {
  code: string
  title: string
  problem: string | null
  urgency: 'past_due' | 'currently_due' | 'eventually_due'
  blocks: Array<'card_payments' | 'payouts'>
  waitingOn: 'owner' | 'stripe'
}

const CURRENCY = { AU: 'AUD', IN: 'INR' } as const
const DEFAULT_METHODS: PaymentMethod[] = ['card', 'apple_pay', 'google_pay']

type AccountState = Pick<Stripe.V2.Core.Account, 'configuration' | 'requirements'>
type Entry = Stripe.V2.Core.Account.Requirements.Entry
type TenantRow = { id: string; name: string; contactEmail: string; country: 'AU' | 'IN'; slug: string | null }

// Plain-English titles, matched by substring in order (first hit wins).
const TITLES: Array<[string, string]> = [
  ['documents', 'Identity document'],
  ['external_account', 'Bank account for payouts'],
  ['bank_account', 'Bank account for payouts'],
  ['tos_acceptance', "Accept Stripe's terms"],
  ['terms_of_service', "Accept Stripe's terms"],
  ['representative', 'Owners and directors'],
  ['owners', 'Owners and directors'],
  ['directors', 'Owners and directors'],
  ['business_profile', 'Business details'],
  ['url', 'Business details'],
  ['mcc', 'Business details'],
  ['product_description', 'Business details'],
  ['individual', "Owner's personal details"],
  ['company', 'Company details'],
  ['registration', 'Company details'],
  ['tax_id', 'Company details'],
]

/** Plain-English name for a Stripe requirement code; falls back to its humanised last two segments. */
export function requirementTitle(code: string): string {
  const hit = TITLES.find(([part]) => code.includes(part))
  if (hit) return hit[1]
  const text = code.split('.').slice(-2).join(' ').replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** One Stripe requirement entry -> the contract's owner-readable shape. */
export function toRequirement(entry: Entry): PaymentRequirement {
  const status = entry.minimum_deadline?.status
  const restricted = (entry.impact?.restricts_capabilities ?? []).map((r) => r.capability)
  return {
    code: entry.description,
    title: requirementTitle(entry.description),
    problem: entry.errors?.[0]?.description ?? null,
    urgency: status === 'past_due' || status === 'currently_due' ? status : 'eventually_due',
    blocks: [
      ...(restricted.includes('card_payments') ? (['card_payments'] as const) : []),
      ...(restricted.includes('stripe_balance.payouts') ? (['payouts'] as const) : []),
    ],
    waitingOn: entry.awaiting_action_from === 'user' ? 'owner' : 'stripe',
  }
}

/**
 * Stripe account -> contract status. active: card payments are on. onboarding: the
 * owner still owes Stripe only the routine first-time form (nothing submitted, no
 * errors). Anything else (under review, rejected details, extra verification) is restricted.
 */
export function accountStatus(account: AccountState | null): { status: PaymentsStatus; requirementsDue: number } {
  if (!account) return { status: 'not_connected', requirementsDue: 0 }
  const entries = account.requirements?.entries ?? []
  if (cardActive(account)) {
    return { status: 'active', requirementsDue: entries.length }
  }
  const neverSubmitted =
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry.awaiting_action_from === 'user' &&
        entry.errors.length === 0 &&
        entry.requested_reasons.every((reason) => reason.code === 'routine_onboarding'),
    )
  return { status: neverSubmitted ? 'onboarding' : 'restricted', requirementsDue: entries.length }
}

const cardActive = (account: AccountState): boolean => account.configuration?.merchant?.capabilities?.card_payments?.status === 'active'
const payoutsActive = (account: AccountState): boolean => account.configuration?.merchant?.capabilities?.stripe_balance?.payouts?.status === 'active'

/** Has the owner been through Stripe's form? Yes unless every entry is still purely routine onboarding. */
export function detailsSubmitted(account: AccountState | null): boolean {
  if (!account) return false
  const entries = account.requirements?.entries ?? []
  if (cardActive(account) || payoutsActive(account) || entries.length === 0) return true
  return entries.some((e) => !e.requested_reasons.every((r) => r.code === 'routine_onboarding'))
}

/** The return/refresh/success/cancel URLs carry who and where, so /stripe/done can route the visitor on. */
export function doneUrl(tenant: { id: string; slug: string | null }, flow: string): string {
  const slug = tenant.slug ? `&slug=${encodeURIComponent(tenant.slug)}` : ''
  return `${process.env.WEB_ORIGIN}/stripe/done?flow=${flow}&tenant=${tenant.id}${slug}`
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RegionRegistryService,
    private readonly stripe: StripeService,
  ) {}

  async get(tenantId: string): Promise<{ payments: PaymentsView }> {
    const plane = await this.resolvePlane(tenantId)
    const { tenant, row } = await this.read(plane, tenantId)
    return { payments: await this.view(plane, tenant, row) }
  }

  async onboardingLink(tenantId: string): Promise<{ url: string; expiresAt: string; payments: PaymentsView }> {
    const plane = await this.resolvePlane(tenantId)
    const stripe = this.stripe.client()
    const { tenant, row: existing } = await this.read(plane, tenantId)
    let row = existing
    let accountId = row?.stripeAccountId
    if (!accountId) {
      const currency = CURRENCY[tenant.country].toLowerCase()
      // The idempotency key makes two racing first clicks create one account, not two.
      const account = await stripe.v2.core.accounts.create(
        {
          display_name: tenant.name,
          contact_email: tenant.contactEmail,
          identity: { country: tenant.country.toLowerCase() },
          dashboard: 'none',
          defaults: { currency, responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
          configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
          metadata: { tenantId },
        },
        { idempotencyKey: `restiq-connect-account-${tenantId}` },
      )
      accountId = account.id
      row = await this.inTenant(plane, tenantId, (tx) =>
        tx.tenantPaymentAccount.upsert({ where: { tenantId }, create: { tenantId, stripeAccountId: accountId }, update: { stripeAccountId: accountId } }),
      )
    }
    const link = await stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: { return_url: doneUrl(tenant, 'onboarding'), refresh_url: doneUrl(tenant, 'expired') },
      },
    })
    return { url: link.url, expiresAt: new Date(link.expires_at).toISOString(), payments: await this.view(plane, tenant, row) }
  }

  async update(operator: OpsPrincipal, tenantId: string, dto: UpdatePaymentsDto): Promise<{ payments: PaymentsView }> {
    const plane = await this.resolvePlane(tenantId)
    const data = {
      ...(dto.allowedMethods ? { allowedMethods: dto.allowedMethods } : {}),
      ...(dto.feePercentBps !== undefined ? { feePercentBps: dto.feePercentBps } : {}),
      ...(dto.feeFixedMinor !== undefined ? { feeFixedMinor: BigInt(dto.feeFixedMinor) } : {}),
    }
    const { tenant, row } = await this.inTenant(plane, tenantId, async (tx) => {
      const tenant = await this.requireTenant(tx, tenantId)
      const row = await tx.tenantPaymentAccount.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data })
      await tx.auditEvent.create({
        data: { tenantId, actorId: operator.id, actorEmail: operator.email, action: 'payments.updated', reason: dto.reason, occurredAt: new Date() },
      })
      return { tenant, row }
    })
    return { payments: await this.view(plane, tenant, row) }
  }

  private async view(plane: PrismaClient, tenant: TenantRow, row: TenantPaymentAccount | null): Promise<PaymentsView> {
    const accountId = row?.stripeAccountId ?? null
    const account = accountId
      ? await this.stripe.client().v2.core.accounts.retrieve(accountId, { include: ['configuration.merchant', 'requirements'] })
      : null
    const status = accountStatus(account)
    const active = status.status === 'active'
    if (row && row.cardPaymentsActive !== active) {
      await this.inTenant(plane, tenant.id, (tx) => tx.tenantPaymentAccount.update({ where: { tenantId: tenant.id }, data: { cardPaymentsActive: active } }))
    }
    return {
      tenantId: tenant.id,
      stripeAccountId: accountId,
      ...status,
      cardPaymentsActive: !!account && cardActive(account),
      payoutsActive: !!account && payoutsActive(account),
      detailsSubmitted: detailsSubmitted(account),
      requirements: (account?.requirements?.entries ?? []).map(toRequirement),
      allowedMethods: (row?.allowedMethods as PaymentMethod[] | undefined) ?? DEFAULT_METHODS,
      feePercentBps: row?.feePercentBps ?? 0,
      feeFixedMinor: (row?.feeFixedMinor ?? 0n).toString(),
      currency: CURRENCY[tenant.country],
    }
  }

  private read(plane: PrismaClient, tenantId: string): Promise<{ tenant: TenantRow; row: TenantPaymentAccount | null }> {
    return plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      const tenant = await this.requireTenant(tx, tenantId)
      return { tenant, row: await tx.tenantPaymentAccount.findUnique({ where: { tenantId } }) }
    })
  }

  /** Writes run under the tenant RLS context (AD-8), like the subscriptions service. */
  private inTenant<T>(plane: PrismaClient, tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      return work(tx)
    })
  }

  private async requireTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantRow> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId, deletedAt: null },
      select: { id: true, name: true, contactEmail: true, country: true, slug: true },
    })
    if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
    return tenant
  }

  private async resolvePlane(tenantId: string): Promise<PrismaClient> {
    const entry = await this.prisma.client.tenantRegistryEntry.findUnique({ where: { tenantId } })
    if (!entry || entry.lifecycle === 'deleted') throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
    return this.registry.planeFor(entry.region)
  }
}
