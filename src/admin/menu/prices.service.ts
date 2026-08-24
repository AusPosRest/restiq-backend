// The ONE place item_prices is ever written from this module (AD-11): every
// price edit is an INSERT, never an UPDATE - the old row is left exactly as
// it was. Price changes are one of the SPEC's named security-relevant
// actions, so unlike routine content edits this also writes an audit_events
// row with the caller's reason, in the same transaction as the insert.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { PriceChannel } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { CreatePriceDto, CurrentPriceView, ItemPriceView } from './items.dtos'
import { resolveCurrentPrice } from './pricing'
import { setTenantContext } from './tenant-context'

function toView(row: { id: string; itemId: string; variantId: string | null; channel: PriceChannel | null; outletId: string | null; priceMinor: bigint; currency: string; effectiveAt: Date; createdAt: Date }): ItemPriceView {
  return {
    id: row.id,
    itemId: row.itemId,
    variantId: row.variantId,
    channel: row.channel,
    outletId: row.outletId,
    priceMinor: Number(row.priceMinor),
    currency: row.currency,
    effectiveAt: row.effectiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

@Injectable()
export class PricesService {
  constructor(private readonly registry: RegionRegistryService) {}

  async create(owner: AdminPrincipal, itemId: string, dto: CreatePriceDto): Promise<ItemPriceView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const item = await tx.menuItem.findUnique({ where: { id: itemId } })
      if (!item || item.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such menu item' })
      }
      if (dto.variantId) {
        const variant = await tx.itemVariant.findUnique({ where: { id: dto.variantId } })
        if (!variant || variant.tenantId !== owner.tenantId || variant.itemId !== itemId) {
          throw new BadRequestException({ code: 'validation_failed', message: 'No such variant on this item' })
        }
      }
      if (dto.outletId) {
        const outlet = await tx.outlet.findUnique({ where: { id: dto.outletId } })
        if (!outlet || outlet.tenantId !== owner.tenantId) {
          throw new BadRequestException({ code: 'validation_failed', message: 'No such outlet' })
        }
      }

      const created = await tx.itemPrice.create({
        data: {
          tenantId: owner.tenantId,
          itemId,
          variantId: dto.variantId ?? null,
          outletId: dto.outletId ?? null,
          channel: dto.channel,
          priceMinor: BigInt(dto.priceMinor),
          currency: dto.currency,
          ...(dto.effectiveAt ? { effectiveAt: new Date(dto.effectiveAt) } : {}),
        },
      })

      await tx.auditEvent.create({
        data: {
          tenantId: owner.tenantId,
          actorId: owner.id,
          actorEmail: owner.email,
          action: 'menu.item.price_changed',
          reason: dto.reason,
          occurredAt: new Date(),
        },
      })

      return toView(created)
    })
  }

  async currentPrice(owner: AdminPrincipal, itemId: string, params: { channel: PriceChannel; variantId?: string; outletId?: string }): Promise<CurrentPriceView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const item = await tx.menuItem.findUnique({ where: { id: itemId } })
      if (!item || item.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such menu item' })
      }

      const resolved = await resolveCurrentPrice(tx, {
        tenantId: owner.tenantId,
        itemId,
        variantId: params.variantId ?? null,
        channel: params.channel,
        outletId: params.outletId ?? null,
      })
      if (!resolved) {
        throw new NotFoundException({ code: 'no_current_price', message: 'This item has no current price for the given channel' })
      }

      return {
        itemId,
        variantId: params.variantId ?? null,
        channel: params.channel,
        outletId: params.outletId ?? null,
        priceMinor: Number(resolved.priceMinor),
        currency: resolved.currency,
        effectiveAt: resolved.effectiveAt.toISOString(),
      }
    })
  }
}
