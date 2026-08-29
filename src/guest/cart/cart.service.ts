// qr-self-order/CAP-3 (issue #72): the shared table cart - every guest in a
// TableSession adds to one cart, each line attributed to the guest who added
// it (CartLine.guestId/guestName). This is session state, not an Order (see
// CartLine's schema comment) - a real Order/OrderLine set is only created at
// placement (CAP-4, a later story).
//
// Built against the same real catalogue pos/orders/order-lines.service.ts
// validates against (tenant-admin/CAP-4's MenuItem/ItemVariant/
// ModifierGroup/Modifier - see src/admin/menu). The item-availability and
// modifier min/max checks below mirror that file's rules exactly (read it
// first) - duplicated per this workspace's existing convention of small,
// module-local helpers (AD-2: cross-module reach only via a module's own
// barrel; the guest realm never imports pos-internal, non-exported
// functions), not a second, drifting reimplementation of the business rule.
import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common'
import { resolveCurrentPrice } from '../../admin'
import type { CartLine, Prisma, PriceChannel, TableSession } from '../../generated/prisma/client'
import { GuestPrincipal, RegionRegistryService } from '../../platform'
import { isSessionInactive } from '../sessions/sessions.service'
import { setTenantContext } from '../tenant-context'
import { AddCartLineDto, CartLineView, GuestCartView, TableCartView, UpdateCartLineDto } from './cart.dtos'

type Tx = Prisma.TransactionClient

// Guest self-order pricing is its own channel (PriceChannel.qr), distinct
// from pos/orders/order-lines.service.ts's ORDER_PRICE_CHANNEL ('dine_in') -
// a tenant may price the QR surface differently from a table order taken by
// staff. Falls back to an unscoped (channel-null) price row the same way
// every other channel does (admin/menu/pricing.ts's pickCurrentPrice).
const CART_PRICE_CHANNEL: PriceChannel = 'qr'

// No tenant-wide default-currency column exists yet (only item_prices/combos
// carry a per-row currency, AD-11) - an empty cart falls back to this, same
// India-first posture as the rest of the demo data (Asia/Kolkata outlets).
const FALLBACK_CURRENCY = 'INR'

type ItemForCartLine = Prisma.MenuItemGetPayload<{
  include: {
    variants: true
    modifierGroups: { include: { group: { include: { modifiers: true } } } }
  }
}>

const ITEM_INCLUDE = {
  variants: true,
  modifierGroups: { include: { group: { include: { modifiers: true } } } },
} satisfies Prisma.MenuItemInclude

const LINE_INCLUDE = {
  item: true,
  variant: true,
  modifiers: { include: { modifier: true } },
} satisfies Prisma.CartLineInclude

type CartLineWithRelations = Prisma.CartLineGetPayload<{ include: typeof LINE_INCLUDE }>

async function loadItemForCartLine(tx: Tx, tenantId: string, itemId: string): Promise<ItemForCartLine> {
  const item = await tx.menuItem.findUnique({ where: { id: itemId }, include: ITEM_INCLUDE })
  if (!item || item.tenantId !== tenantId) {
    throw new BadRequestException({ code: 'validation_failed', message: 'No such menu item' })
  }
  return item
}

function assertVariantBelongsToItem(item: ItemForCartLine, variantId: string | undefined): void {
  if (variantId === undefined) return
  if (!item.variants.some((v) => v.id === variantId)) {
    throw new BadRequestException({ code: 'validation_failed', message: 'That variant does not belong to this item' })
  }
}

/**
 * Mirrors pos/orders/order-lines.service.ts's assertModifierSelectionValid
 * exactly (same rule, SPEC qr-self-order CAP-2 success criterion) - a
 * modifier group violating its own min/max cannot be added, regardless of
 * what a client already validated.
 */
function assertModifierSelectionValid(item: ItemForCartLine, modifierIds: string[]): void {
  const validModifierIds = new Set(item.modifierGroups.flatMap((link) => link.group.modifiers.map((m) => m.id)))
  for (const id of modifierIds) {
    if (!validModifierIds.has(id)) {
      throw new BadRequestException({ code: 'validation_failed', message: 'One or more modifiers do not belong to this item' })
    }
  }

  for (const link of item.modifierGroups) {
    const group = link.group
    const selectedCount = group.modifiers.filter((m) => modifierIds.includes(m.id)).length
    if (selectedCount < group.minSelections || selectedCount > group.maxSelections) {
      throw new BadRequestException({
        code: 'modifier_selection_invalid',
        message: `"${group.name}" requires between ${group.minSelections} and ${group.maxSelections} selection(s), got ${selectedCount}`,
      })
    }
  }
}

/**
 * CAP-2 success criterion: "an 86'd item shows unavailable and cannot be
 * added" - checks the tenant-wide toggle (MenuItem.available) AND this
 * outlet's override (ItemOutletOverride), the same two availability sources
 * Tenant Admin's items.service.ts writes (admin/menu/items.service.ts's
 * setAvailability/setOutletAvailability). Never a guest-side copy of either.
 */
async function assertItemAvailable(tx: Tx, outletId: string, item: ItemForCartLine): Promise<void> {
  if (!item.available) {
    throw new BadRequestException({ code: 'item_unavailable', message: 'This item is currently unavailable' })
  }
  const override = await tx.itemOutletOverride.findUnique({ where: { itemId_outletId: { itemId: item.id, outletId } } })
  if (override && !override.available) {
    throw new BadRequestException({ code: 'item_unavailable', message: 'This item is currently unavailable' })
  }
}

async function loadActiveSession(tx: Tx, guest: GuestPrincipal): Promise<TableSession> {
  const session = await tx.tableSession.findUnique({ where: { id: guest.sessionId } })
  if (!session) {
    throw new NotFoundException({ code: 'not_found', message: 'No such session' })
  }
  if (isSessionInactive(session)) {
    throw new GoneException({ code: 'session_closed', message: 'This table session has ended' })
  }
  return session
}

async function loadCartLine(tx: Tx, tenantId: string, sessionId: string, lineId: string): Promise<CartLine> {
  const line = await tx.cartLine.findUnique({ where: { id: lineId } })
  if (!line || line.tenantId !== tenantId || line.sessionId !== sessionId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such cart line' })
  }
  return line
}

/** CAP-3 ownership rule: any guest may view all lines, but only the guest who added a line may edit or remove it. */
function assertOwnedByGuest(line: CartLine, guest: GuestPrincipal): void {
  if (line.guestId !== guest.id) {
    throw new ForbiddenException({ code: 'forbidden', message: 'Only the guest who added this line may change it' })
  }
}

async function resolveUnitPriceMinor(tx: Tx, tenantId: string, outletId: string, itemId: string, variantId: string | null): Promise<{ priceMinor: number; currency: string } | null> {
  const price = await resolveCurrentPrice(tx, { tenantId, itemId, variantId, channel: CART_PRICE_CHANNEL, outletId })
  if (!price) return null
  return { priceMinor: Number(price.priceMinor), currency: price.currency }
}

async function toCartLineView(tx: Tx, tenantId: string, outletId: string, line: CartLineWithRelations): Promise<{ view: CartLineView; currency: string | null }> {
  const resolved = await resolveUnitPriceMinor(tx, tenantId, outletId, line.itemId, line.variantId)
  const unitPriceMinor = resolved?.priceMinor ?? 0
  const modifiers = line.modifiers.map((m) => ({ id: m.modifier.id, name: m.modifier.name, priceMinor: Number(m.modifier.priceMinor) }))
  const modifiersTotal = modifiers.reduce((sum, m) => sum + m.priceMinor, 0)
  return {
    currency: resolved?.currency ?? null,
    view: {
      id: line.id,
      guestId: line.guestId,
      guestName: line.guestName,
      itemId: line.itemId,
      itemName: line.item.name,
      variantId: line.variantId,
      variantName: line.variant?.name ?? null,
      quantity: line.quantity,
      unitPriceMinor,
      modifiers,
      lineTotalMinor: (unitPriceMinor + modifiersTotal) * line.quantity,
      createdAt: line.createdAt.toISOString(),
    },
  }
}

async function buildCartView(tx: Tx, tenantId: string, outletId: string, session: TableSession): Promise<TableCartView> {
  const lines = await tx.cartLine.findMany({ where: { tenantId, sessionId: session.id }, include: LINE_INCLUDE, orderBy: { createdAt: 'asc' } })

  const byGuest = new Map<string, GuestCartView>()
  let currency = FALLBACK_CURRENCY
  for (const line of lines) {
    const { view, currency: lineCurrency } = await toCartLineView(tx, tenantId, outletId, line)
    if (lineCurrency) currency = lineCurrency

    let guestCart = byGuest.get(line.guestId)
    if (!guestCart) {
      guestCart = { guestId: line.guestId, guestName: line.guestName, lines: [], subtotalMinor: 0 }
      byGuest.set(line.guestId, guestCart)
    }
    guestCart.lines.push(view)
    guestCart.subtotalMinor += view.lineTotalMinor
  }

  const guests = [...byGuest.values()]
  const totalMinor = guests.reduce((sum, g) => sum + g.subtotalMinor, 0)
  return { sessionId: session.id, guests, totalMinor, currency }
}

@Injectable()
export class CartService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async getCart(guest: GuestPrincipal): Promise<TableCartView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const session = await loadActiveSession(tx, guest)
      return buildCartView(tx, guest.tenantId, guest.outletId, session)
    })
  }

  async addLine(guest: GuestPrincipal, dto: AddCartLineDto): Promise<TableCartView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const session = await loadActiveSession(tx, guest)

      const item = await loadItemForCartLine(tx, guest.tenantId, dto.itemId)
      assertVariantBelongsToItem(item, dto.variantId)
      await assertItemAvailable(tx, guest.outletId, item)
      const modifierIds = dto.modifierIds ?? []
      assertModifierSelectionValid(item, modifierIds)

      const line = await tx.cartLine.create({
        data: {
          tenantId: guest.tenantId,
          sessionId: session.id,
          guestId: guest.id,
          guestName: guest.name,
          itemId: dto.itemId,
          variantId: dto.variantId ?? null,
          quantity: dto.quantity,
        },
      })
      for (const modifierId of modifierIds) {
        await tx.cartLineModifier.create({ data: { tenantId: guest.tenantId, cartLineId: line.id, modifierId } })
      }

      return buildCartView(tx, guest.tenantId, guest.outletId, session)
    })
  }

  async updateLine(guest: GuestPrincipal, lineId: string, dto: UpdateCartLineDto): Promise<TableCartView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const session = await loadActiveSession(tx, guest)
      const line = await loadCartLine(tx, guest.tenantId, session.id, lineId)
      assertOwnedByGuest(line, guest)

      if (dto.quantity !== undefined) {
        await tx.cartLine.update({ where: { id: lineId }, data: { quantity: dto.quantity } })
      }

      if (dto.modifierIds !== undefined) {
        const item = await loadItemForCartLine(tx, guest.tenantId, line.itemId)
        assertModifierSelectionValid(item, dto.modifierIds)
        await tx.cartLineModifier.deleteMany({ where: { cartLineId: lineId } })
        for (const modifierId of dto.modifierIds) {
          await tx.cartLineModifier.create({ data: { tenantId: guest.tenantId, cartLineId: lineId, modifierId } })
        }
      }

      return buildCartView(tx, guest.tenantId, guest.outletId, session)
    })
  }

  async removeLine(guest: GuestPrincipal, lineId: string): Promise<TableCartView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const session = await loadActiveSession(tx, guest)
      const line = await loadCartLine(tx, guest.tenantId, session.id, lineId)
      assertOwnedByGuest(line, guest)

      await tx.cartLine.delete({ where: { id: lineId } })
      return buildCartView(tx, guest.tenantId, guest.outletId, session)
    })
  }
}
