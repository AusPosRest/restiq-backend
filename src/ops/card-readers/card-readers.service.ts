// #286 card readers: Stripe Terminal smart readers (server-driven) on the restaurant's connected
// account, one Terminal Location per outlet. Operators register and remove them; owners and the POS
// list them. Live online/offline comes from Stripe on every read, never stored. Reader list prices
// (platform-level, like PlanPrice) live here too.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import Stripe from 'stripe'
import type { Prisma } from '../../generated/prisma/client'
import { ControlPlaneAuditService, OpsPrincipal, RegionRegistryService, StripeService, stripeTestKey } from '../../platform'
import { CardReaderView, READER_COUNTRIES, READER_MODELS, ReaderPriceView, RegisterCardReaderDto, UpdateReaderPriceDto } from './card-readers.dtos'

type Tx = Prisma.TransactionClient
type ReaderRow = { id: string; outletId: string; stripeReaderId: string; label: string; deviceType: string; serialNumber: string; outlet: { name: string } }
type PriceRow = { country: 'AU' | 'IN'; model: 's700' | 'wisepos_e'; displayName: string; priceMinor: bigint | null; updatedAt: Date }

export const CURRENCY = { AU: 'AUD', IN: 'INR' } as const

// Stripe's sandbox registration codes for simulated readers (simulated-wpe, simulated-s700, ...).
const SIMULATED_CODE = /^simulated-/

export const READER_INCLUDE = { outlet: { select: { name: true } } } as const

export function toPriceView(row: PriceRow): ReaderPriceView {
  return {
    country: row.country,
    model: row.model,
    displayName: row.displayName,
    priceMinor: row.priceMinor === null ? null : row.priceMinor.toString(),
    currency: CURRENCY[row.country],
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function readerStatus(status: string | null | undefined): CardReaderView['status'] {
  return status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'unknown'
}

export function providerUnavailable(): ConflictException {
  return new ConflictException({ code: 'provider_unavailable', message: 'This restaurant has no active Stripe account for card payments yet' })
}

export async function setTenantContext(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
  await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
}

export async function requireTenant(tx: Tx, tenantId: string): Promise<{ id: string; name: string; country: 'AU' | 'IN' }> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId, deletedAt: null }, select: { id: true, name: true, country: true } })
  if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
  return tenant
}

@Injectable()
export class CardReadersService {
  private readonly logger = new Logger(CardReadersService.name)

  constructor(
    private readonly registry: RegionRegistryService,
    private readonly stripe: StripeService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  // ---- prices -------------------------------------------------------------

  async listPrices(): Promise<{ prices: ReaderPriceView[] }> {
    const rows = await this.plane().readerPrice.findMany({ orderBy: [{ country: 'asc' }, { model: 'asc' }] })
    return { prices: rows.map(toPriceView) }
  }

  async updatePrice(operator: OpsPrincipal, country: string, model: string, dto: UpdateReaderPriceDto): Promise<{ price: ReaderPriceView }> {
    const c = READER_COUNTRIES.find((value) => value === country)
    const m = READER_MODELS.find((value) => value === model)
    if (!c || !m) throw new BadRequestException({ code: 'validation_failed', message: 'Unknown country or reader model' })
    const priceMinor = dto.priceMinor === null ? null : BigInt(dto.priceMinor)
    const existing = await this.plane().readerPrice.findUnique({ where: { country_model: { country: c, model: m } } })
    const displayName = dto.displayName ?? existing?.displayName ?? m
    const row = await this.plane().readerPrice.upsert({
      where: { country_model: { country: c, model: m } },
      create: { country: c, model: m, displayName, priceMinor },
      update: { displayName, priceMinor },
    })
    const price = dto.priceMinor === null ? 'not for sale' : `${CURRENCY[c]} ${(dto.priceMinor / 100).toFixed(2)}`
    await this.audit.record({
      actorId: operator.id,
      actorEmail: operator.email,
      action: 'reader_price.updated',
      reason: `${c} ${displayName}: ${price} - ${dto.reason}`,
      occurredAt: new Date(),
    })
    return { price: toPriceView(row) }
  }

  // ---- readers ------------------------------------------------------------

  async listForTenant(tenantId: string): Promise<{ readers: CardReaderView[] }> {
    const { accountId, rows } = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      await requireTenant(tx, tenantId)
      const account = await tx.tenantPaymentAccount.findUnique({ where: { tenantId } })
      const rows = await tx.cardReader.findMany({ where: { tenantId }, include: READER_INCLUDE, orderBy: { createdAt: 'asc' } })
      return { accountId: account?.stripeAccountId ?? null, rows }
    })
    return { readers: await this.views(accountId, rows) }
  }

  /** Rows -> views, with live status from one Stripe list call. Stripe being unreachable reads as 'unknown', never an error. */
  async views(accountId: string | null, rows: ReaderRow[]): Promise<CardReaderView[]> {
    if (rows.length === 0) return []
    let live = new Map<string, Stripe.Terminal.Reader>()
    if (accountId) {
      try {
        // ponytail: one page of 100 readers per account; paginate if a tenant ever has more.
        const list = await this.stripe.client().terminal.readers.list({ limit: 100 }, { stripeAccount: accountId })
        live = new Map(list.data.map((reader) => [reader.id, reader]))
      } catch (error) {
        if (!(error instanceof Stripe.errors.StripeError)) throw error
        this.logger.warn(`Reader status for ${accountId} unavailable: ${error.message}`)
      }
    }
    return rows.map((row) => {
      return {
        id: row.id,
        outletId: row.outletId,
        outletName: row.outlet.name,
        label: row.label,
        deviceType: row.deviceType,
        serialNumber: row.serialNumber,
        status: readerStatus(live.get(row.stripeReaderId)?.status),
        simulated: row.deviceType.startsWith('simulated'),
      }
    })
  }

  /**
   * POST ops/v1/tenants/:id/card-readers. The outlet's Terminal Location is made on its first reader.
   * Stripe calls run outside any transaction; the location is saved with a compare-and-set so two
   * racing first registrations keep one location.
   */
  async register(operator: OpsPrincipal, tenantId: string, dto: RegisterCardReaderDto): Promise<{ reader: CardReaderView }> {
    if (SIMULATED_CODE.test(dto.registrationCode) && !stripeTestKey()) {
      throw new BadRequestException({ code: 'validation_failed', message: 'Simulated readers can only be registered on a Stripe test key' })
    }
    const stripe = this.stripe.client()
    const plan = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const tenant = await requireTenant(tx, tenantId)
      const account = await tx.tenantPaymentAccount.findUnique({ where: { tenantId } })
      if (!account?.stripeAccountId || !account.cardPaymentsActive) throw providerUnavailable()
      const outlet = await tx.outlet.findFirst({ where: { id: dto.outletId, tenantId, deletedAt: null } })
      if (!outlet) throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      if (!outlet.stripeTerminalLocationId && !dto.address) {
        throw new ConflictException({ code: 'address_required', message: "This outlet's first reader needs the outlet's street address" })
      }
      return { tenant, accountId: account.stripeAccountId, outlet }
    })
    const opts = { stripeAccount: plan.accountId }

    let locationId = plan.outlet.stripeTerminalLocationId
    if (!locationId && dto.address) {
      const location = await stripeRequest(() =>
        stripe.terminal.locations.create(
          {
            display_name: plan.outlet.name,
            address: { line1: dto.address!.line1, city: dto.address!.city, state: dto.address!.state, postal_code: dto.address!.postcode, country: plan.tenant.country },
            metadata: { tenantId, outletId: plan.outlet.id },
          },
          opts,
        ),
      )
      locationId = await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, tenantId)
        await tx.outlet.updateMany({ where: { id: plan.outlet.id, stripeTerminalLocationId: null }, data: { stripeTerminalLocationId: location.id } })
        return (await tx.outlet.findUniqueOrThrow({ where: { id: plan.outlet.id } })).stripeTerminalLocationId
      })
      if (locationId !== location.id) await stripe.terminal.locations.del(location.id, {}, opts).catch(() => undefined)
    }

    const reader = await stripeRequest(() =>
      stripe.terminal.readers.create({ registration_code: dto.registrationCode, label: dto.label, location: locationId ?? undefined, metadata: { tenantId, outletId: plan.outlet.id } }, opts),
    )
    try {
      const row = await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, tenantId)
        const row = await tx.cardReader.create({
          data: { tenantId, outletId: plan.outlet.id, stripeReaderId: reader.id, label: dto.label, deviceType: reader.device_type, serialNumber: reader.serial_number },
          include: READER_INCLUDE,
        })
        await tx.auditEvent.create({
          data: { tenantId, actorId: operator.id, actorEmail: operator.email, action: 'card_reader.registered', reason: `${dto.label} (${reader.device_type}) at ${plan.outlet.name}`, occurredAt: new Date() },
        })
        return row
      })
      const [view] = await this.views(null, [row])
      return { reader: { ...view, status: readerStatus(reader.status) } }
    } catch (error) {
      // Not saved here: leave nothing registered at Stripe either.
      await stripe.terminal.readers.del(reader.id, {}, opts).catch(() => undefined)
      throw error
    }
  }

  /** DELETE ops/v1/tenants/:id/card-readers/:readerId - removed at Stripe too (already gone there is fine). */
  async remove(operator: OpsPrincipal, tenantId: string, readerId: string, reason: string): Promise<void> {
    const { row, accountId } = await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      await requireTenant(tx, tenantId)
      const row = await tx.cardReader.findFirst({ where: { id: readerId, tenantId }, include: READER_INCLUDE })
      if (!row) throw new NotFoundException({ code: 'not_found', message: 'No such card reader' })
      const account = await tx.tenantPaymentAccount.findUnique({ where: { tenantId } })
      return { row, accountId: account?.stripeAccountId ?? null }
    })
    if (accountId) {
      try {
        await this.stripe.client().terminal.readers.del(row.stripeReaderId, {}, { stripeAccount: accountId })
      } catch (error) {
        if (!(error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404)) throw error
      }
    }
    await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      await tx.cardReader.deleteMany({ where: { id: row.id, tenantId } })
      await tx.auditEvent.create({
        data: { tenantId, actorId: operator.id, actorEmail: operator.email, action: 'card_reader.removed', reason: `${row.label} at ${row.outlet.name} - ${reason}`, occurredAt: new Date() },
      })
    })
  }
}

/** A Stripe request whose rejection is the caller's to fix (a bad registration code or address) answers 400 with Stripe's message. */
async function stripeRequest<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      throw new BadRequestException({ code: 'validation_failed', message: error.message })
    }
    throw error
  }
}
