// #286 reader orders: an owner orders card readers and pays straight away with the card on file for
// their subscription (a one-off invoice on the PLATFORM Stripe account, charged now, no retry loop).
// Operators then move the order forward (paid -> ordered -> shipped -> delivered); cancelling a paid
// or ordered order refunds the platform payment. The platform webhook keeps paid/failed in step.
//
// The order row is written before the charge, as payment_failed with a placeholder message, so a
// crash after Stripe took the money still leaves a row the invoice.paid webhook can mark paid.
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { isUUID } from 'class-validator'
import Stripe from 'stripe'
import type { Prisma, ReaderOrder } from '../../generated/prisma/client'
import { AdminPrincipal, OpsPrincipal, RegionRegistryService, StripeService, uuidv7 } from '../../platform'
import {
  CardReaderView,
  CreateReaderOrderDto,
  ReaderOrderStatusName,
  ReaderOrderView,
  ReaderPriceView,
  ShippingAddress,
  UpdateReaderOrderDto,
} from './card-readers.dtos'
import { CardReadersService, CURRENCY, READER_INCLUDE, requireTenant, setTenantContext, toPriceView } from './card-readers.service'

type Tx = Prisma.TransactionClient
type OrderRow = ReaderOrder & { tenant: { name: string }; outlet: { name: string } }

const ORDER_INCLUDE = { tenant: { select: { name: true } }, outlet: { select: { name: true } } } as const
export const PAYMENT_NOT_COMPLETED = 'Payment not completed'

/** Forward-only. Cancelling is allowed until the readers have shipped (and refunds the payment). */
export const NEXT_STATUS: Record<ReaderOrderStatusName, readonly ReaderOrderStatusName[]> = {
  payment_failed: [],
  paid: ['ordered', 'cancelled'],
  ordered: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
}

export function orderTotalMinor(unitPriceMinor: bigint, quantity: number): bigint {
  return unitPriceMinor * BigInt(quantity)
}

/** Is card billing set up so a one-off charge can go to the subscription's card? */
export function cardOnFile(sub: { stripeCustomerId: string | null; stripeSubscriptionId: string | null; cardBillingStatus: string | null } | null): boolean {
  return !!sub?.stripeCustomerId && !!sub.stripeSubscriptionId && (sub.cardBillingStatus === 'active' || sub.cardBillingStatus === 'past_due')
}

const DISPLAY_FALLBACK = { s700: 'Stripe Reader S700', wisepos_e: 'BBPOS WisePOS E' } as const

function toOrderView(row: OrderRow, displayName: string): ReaderOrderView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantName: row.tenant.name,
    outletId: row.outletId,
    outletName: row.outlet.name,
    model: row.model,
    displayName,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor.toString(),
    totalMinor: row.totalMinor.toString(),
    currency: row.currency,
    shipping: row.shipping as unknown as ShippingAddress,
    status: row.status,
    failureMessage: row.failureMessage,
    trackingRef: row.trackingRef,
    opsNote: row.opsNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function operatorContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

@Injectable()
export class ReaderOrdersService {
  private readonly logger = new Logger(ReaderOrdersService.name)

  constructor(
    private readonly registry: RegionRegistryService,
    private readonly stripe: StripeService,
    private readonly readers: CardReadersService,
  ) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  private async views(rows: OrderRow[]): Promise<ReaderOrderView[]> {
    const names = await this.plane().readerPrice.findMany({ select: { country: true, model: true, displayName: true } })
    const nameOf = (row: OrderRow): string =>
      names.find((n) => n.model === row.model && CURRENCY[n.country] === row.currency)?.displayName ?? DISPLAY_FALLBACK[row.model]
    return rows.map((row) => toOrderView(row, nameOf(row)))
  }

  // ---- ops ----------------------------------------------------------------

  /** GET ops/v1/reader-orders?status= - across tenants (operator_read RLS policy). */
  async listAll(status?: ReaderOrderStatusName): Promise<{ orders: ReaderOrderView[] }> {
    const rows = await this.plane().$transaction(async (tx) => {
      await operatorContext(tx)
      return tx.readerOrder.findMany({ where: status ? { status } : {}, include: ORDER_INCLUDE, orderBy: { createdAt: 'desc' } })
    })
    return { orders: await this.views(rows) }
  }

  async listForTenant(tenantId: string): Promise<{ orders: ReaderOrderView[] }> {
    const rows = await this.plane().$transaction(async (tx) => {
      await operatorContext(tx)
      await requireTenant(tx, tenantId)
      return tx.readerOrder.findMany({ where: { tenantId }, include: ORDER_INCLUDE, orderBy: { createdAt: 'desc' } })
    })
    return { orders: await this.views(rows) }
  }

  /** PATCH ops/v1/reader-orders/:id. Same status again only updates trackingRef / opsNote. */
  async update(operator: OpsPrincipal, orderId: string, dto: UpdateReaderOrderDto): Promise<{ order: ReaderOrderView }> {
    const current = await this.plane().$transaction(async (tx) => {
      await operatorContext(tx)
      return isUUID(orderId) ? tx.readerOrder.findUnique({ where: { id: orderId } }) : null
    })
    if (!current) throw new NotFoundException({ code: 'not_found', message: 'No such reader order' })
    if (dto.status !== current.status && !NEXT_STATUS[current.status].includes(dto.status)) {
      throw new ConflictException({ code: 'invalid_transition', message: `A ${current.status} order cannot become ${dto.status}` })
    }
    // Refund before the write (Stripe never inside a transaction); the idempotency key makes a retry or a racing second cancel one refund.
    if (dto.status === 'cancelled' && current.status !== 'cancelled') await this.refund(current)

    const row = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, current.tenantId)
      const moved = await tx.readerOrder.updateMany({
        where: { id: current.id, status: current.status },
        data: { status: dto.status, ...(dto.trackingRef !== undefined ? { trackingRef: dto.trackingRef } : {}), ...(dto.opsNote !== undefined ? { opsNote: dto.opsNote } : {}) },
      })
      if (moved.count === 0) throw new ConflictException({ code: 'conflict', message: 'This order changed meanwhile - reload and try again' })
      await tx.auditEvent.create({
        data: {
          tenantId: current.tenantId,
          actorId: operator.id,
          actorEmail: operator.email,
          action: 'reader_order.updated',
          reason: `Order ${current.id}: ${current.status} -> ${dto.status} - ${dto.reason}`,
          occurredAt: new Date(),
        },
      })
      return tx.readerOrder.findUniqueOrThrow({ where: { id: current.id }, include: ORDER_INCLUDE })
    })
    return { order: (await this.views([row]))[0] }
  }

  private async refund(order: ReaderOrder): Promise<void> {
    if (!order.stripeInvoiceId) throw new ConflictException({ code: 'refund_failed', message: 'This order has no Stripe payment to refund' })
    const stripe = this.stripe.client()
    const invoice = await stripe.invoices.retrieve(order.stripeInvoiceId, { expand: ['payments'] })
    const payment = invoice.payments?.data.find((p) => p.status === 'paid' && p.payment.type === 'payment_intent')?.payment.payment_intent
    const paymentIntent = typeof payment === 'string' ? payment : payment?.id
    if (!paymentIntent) throw new ConflictException({ code: 'refund_failed', message: 'No paid Stripe payment was found for this order' })
    await stripe.refunds.create(
      { payment_intent: paymentIntent, metadata: { readerOrderId: order.id, tenantId: order.tenantId } },
      { idempotencyKey: `restiq-reader-order-refund-${order.id}` },
    )
  }

  // ---- owner --------------------------------------------------------------

  /** GET admin/v1/card-readers */
  async ownerOverview(owner: AdminPrincipal): Promise<{ readers: CardReaderView[]; prices: ReaderPriceView[]; cardOnFile: boolean; orders: ReaderOrderView[] }> {
    const data = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const tenant = await requireTenant(tx, owner.tenantId)
      return {
        tenant,
        account: await tx.tenantPaymentAccount.findUnique({ where: { tenantId: owner.tenantId } }),
        readers: await tx.cardReader.findMany({ where: { tenantId: owner.tenantId }, include: READER_INCLUDE, orderBy: { createdAt: 'asc' } }),
        sub: await tx.subscription.findUnique({ where: { tenantId: owner.tenantId } }),
        orders: await tx.readerOrder.findMany({ where: { tenantId: owner.tenantId }, include: ORDER_INCLUDE, orderBy: { createdAt: 'desc' } }),
      }
    })
    const prices = await this.plane().readerPrice.findMany({ where: { country: data.tenant.country, priceMinor: { not: null } }, orderBy: { model: 'asc' } })
    return {
      readers: await this.readers.views(data.account?.stripeAccountId ?? null, data.readers),
      prices: prices.map(toPriceView),
      cardOnFile: cardOnFile(data.sub),
      orders: await this.views(data.orders),
    }
  }

  /** POST admin/v1/reader-orders - charges now; the answer is the order as paid or payment_failed. */
  async create(owner: AdminPrincipal, dto: CreateReaderOrderDto): Promise<{ order: ReaderOrderView }> {
    const tenantId = owner.tenantId
    const plan = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const tenant = await requireTenant(tx, tenantId)
      const outlet = await tx.outlet.findFirst({ where: { id: dto.outletId, tenantId, deletedAt: null } })
      if (!outlet) throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      const price = await tx.readerPrice.findUnique({ where: { country_model: { country: tenant.country, model: dto.model } } })
      if (price?.priceMinor == null) throw new ConflictException({ code: 'not_for_sale', message: 'This reader is not for sale in your country yet' })
      const sub = await tx.subscription.findUnique({ where: { tenantId } })
      if (!cardOnFile(sub) || !sub?.stripeCustomerId || !sub.stripeSubscriptionId) throw cardNotOnFile()
      return { tenant, price, customerId: sub.stripeCustomerId, subscriptionId: sub.stripeSubscriptionId }
    })
    const stripe = this.stripe.client()
    const paymentMethod = await this.subscriptionCard(plan.customerId, plan.subscriptionId)
    if (!paymentMethod) throw cardNotOnFile()

    const orderId = uuidv7()
    const currency = CURRENCY[plan.tenant.country]
    const totalMinor = orderTotalMinor(plan.price.priceMinor!, dto.quantity)
    const shipping: ShippingAddress = { name: dto.shipping.name, line1: dto.shipping.line1, ...(dto.shipping.line2 ? { line2: dto.shipping.line2 } : {}), city: dto.shipping.city, state: dto.shipping.state, postcode: dto.shipping.postcode, phone: dto.shipping.phone }
    await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      await tx.readerOrder.create({
        data: { id: orderId, tenantId, outletId: dto.outletId, model: dto.model, quantity: dto.quantity, unitPriceMinor: plan.price.priceMinor!, totalMinor, currency, shipping: { ...shipping }, status: 'payment_failed', failureMessage: PAYMENT_NOT_COMPLETED },
      })
      await tx.auditEvent.create({
        data: { tenantId, actorId: owner.id, actorEmail: owner.email, action: 'reader_order.placed', reason: `${dto.quantity} x ${plan.price.displayName}, ${currency} ${totalMinor} minor`, occurredAt: new Date() },
      })
    })

    let outcome: { paid: boolean; message: string | null; invoiceId: string | null } = { paid: false, message: PAYMENT_NOT_COMPLETED, invoiceId: null }
    try {
      const key = `restiq-reader-order-${orderId}`
      const metadata = { tenantId, readerOrderId: orderId }
      // pending_invoice_items_behavior exclude: never sweep the subscription's own pending items into this charge.
      const invoice = await stripe.invoices.create(
        { customer: plan.customerId, currency: currency.toLowerCase(), collection_method: 'charge_automatically', default_payment_method: paymentMethod, auto_advance: false, pending_invoice_items_behavior: 'exclude', description: 'Restiq card readers', metadata },
        { idempotencyKey: `${key}-invoice` },
      )
      outcome.invoiceId = invoice.id
      await stripe.invoiceItems.create(
        { customer: plan.customerId, invoice: invoice.id, amount: Number(totalMinor), currency: currency.toLowerCase(), description: `${dto.quantity} x ${plan.price.displayName}`, metadata },
        { idempotencyKey: `${key}-item` },
      )
      await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false }, { idempotencyKey: `${key}-finalize` })
      const paid = await stripe.invoices.pay(invoice.id, {}, { idempotencyKey: `${key}-pay` })
      outcome = { paid: paid.status === 'paid', message: paid.status === 'paid' ? null : 'The card payment did not complete', invoiceId: invoice.id }
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError)) throw error
      outcome.message = error.message
    }

    const row = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      // Only from payment_failed: the webhook may already have marked it paid.
      await tx.readerOrder.updateMany({
        where: { id: orderId, status: 'payment_failed' },
        data: outcome.paid ? { status: 'paid', failureMessage: null, stripeInvoiceId: outcome.invoiceId } : { failureMessage: outcome.message, stripeInvoiceId: outcome.invoiceId },
      })
      return tx.readerOrder.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE })
    })
    return { order: (await this.views([row]))[0] }
  }

  /** The card the subscription is charged to: its own default, else the customer's invoice default. */
  private async subscriptionCard(customerId: string, subscriptionId: string): Promise<string | null> {
    const stripe = this.stripe.client()
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    const own = subscription.default_payment_method
    if (own) return typeof own === 'string' ? own : own.id
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted) return null
    const fallback = customer.invoice_settings?.default_payment_method
    return fallback ? (typeof fallback === 'string' ? fallback : fallback.id) : null
  }

  // ---- platform webhook ---------------------------------------------------

  /**
   * invoice.paid / invoice.payment_failed carrying metadata.readerOrderId. Idempotent: only a
   * payment_failed order moves (to paid), and only when the invoice provably belongs to it.
   */
  async applyInvoice(invoice: Stripe.Invoice, paid: boolean): Promise<'applied' | 'ignored'> {
    const { readerOrderId, tenantId } = invoice.metadata ?? {}
    if (!readerOrderId || !tenantId || !isUUID(readerOrderId) || !isUUID(tenantId) || !invoice.id) return 'ignored'
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const order = await tx.readerOrder.findUnique({ where: { id: readerOrderId } })
      if (!order || order.tenantId !== tenantId || (order.stripeInvoiceId && order.stripeInvoiceId !== invoice.id)) return 'ignored'
      if (invoice.currency !== order.currency.toLowerCase() || (paid && BigInt(invoice.amount_paid) !== order.totalMinor)) {
        this.logger.error(`Invoice ${invoice.id} does not match reader order ${order.id} (amount or currency) - not applied`)
        return 'ignored'
      }
      if (order.status !== 'payment_failed') return 'applied'
      await tx.readerOrder.updateMany({
        where: { id: order.id, status: 'payment_failed' },
        data: paid
          ? { status: 'paid', failureMessage: null, stripeInvoiceId: invoice.id }
          : { stripeInvoiceId: invoice.id, ...(order.failureMessage === PAYMENT_NOT_COMPLETED ? { failureMessage: 'The card payment failed' } : {}) },
      })
      return 'applied'
    })
  }
}

function cardNotOnFile(): ConflictException {
  return new ConflictException({ code: 'card_not_on_file', message: 'Set up card billing for your subscription before ordering readers' })
}
