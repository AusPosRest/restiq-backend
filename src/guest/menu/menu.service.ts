// qr-self-order/CAP-2 (stories.yaml story 2, issue #78): a read-only projection of the
// real catalogue (admin/menu's MenuCategory/MenuItem/ItemVariant/
// ModifierGroup/Allergen/ItemOutletOverride - see restiq-backend/src/
// admin/menu for the already-shipped models) scoped to the guest's own
// outlet, via the outlet dimension already present on pricing/availability -
// never a guest-side copy of the catalogue.
//
// Guest fields (photoUrl, nameHindi, vegMarker) are exposed directly from
// MenuItem (issue #78).
//
// Pricing reuses admin/menu/pricing's resolveCurrentPrice verbatim through
// the admin barrel (never re-derived) with channel 'qr' - the same
// per-item/variant resolution pos/order-lines already relies on for the same
// reason (AD-11: one price-picking implementation).
import { Injectable, NotFoundException } from '@nestjs/common'
import { resolveCurrentPrice } from '../../admin'
import type { Prisma } from '../../generated/prisma/client'
import { GuestPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { GuestMenuView, MenuCategoryView, MenuItemView } from './menu.dtos'

type Tx = Prisma.TransactionClient

const MENU_PRICE_CHANNEL = 'qr' as const

type ItemWithRelations = Prisma.MenuItemGetPayload<{
  include: {
    variants: true
    modifierGroups: { include: { group: { include: { modifiers: true } } } }
    allergens: { include: { allergen: true } }
    outletOverrides: true
  }
}>

const ITEM_INCLUDE = {
  variants: { orderBy: { sortOrder: 'asc' } },
  modifierGroups: { include: { group: { include: { modifiers: { orderBy: { sortOrder: 'asc' } } } } } },
  allergens: { include: { allergen: true } },
  outletOverrides: true,
} satisfies Prisma.MenuItemInclude

/**
 * An outlet's override row, when present, is authoritative regardless of the
 * tenant-wide toggle (schema comment on item_outlet_overrides: "No row = the
 * item's tenant-wide `available` applies at that outlet"). Absent row falls
 * back to the tenant-wide flag.
 */
function resolveAvailability(item: Pick<ItemWithRelations, 'available' | 'outletOverrides'>, outletId: string): boolean {
  const override = item.outletOverrides.find((o) => o.outletId === outletId)
  return override ? override.available : item.available
}

async function toItemView(tx: Tx, tenantId: string, outletId: string, item: ItemWithRelations): Promise<MenuItemView> {
  const hasVariants = item.variants.length > 0
  let priceMinor: number | null = null
  let currency: string | null = null
  if (!hasVariants) {
    const price = await resolveCurrentPrice(tx, { tenantId, itemId: item.id, variantId: null, channel: MENU_PRICE_CHANNEL, outletId })
    priceMinor = price ? Number(price.priceMinor) : null
    currency = price?.currency ?? null
  }

  const variants = await Promise.all(
    item.variants.map(async (variant) => {
      const price = await resolveCurrentPrice(tx, { tenantId, itemId: item.id, variantId: variant.id, channel: MENU_PRICE_CHANNEL, outletId })
      return {
        id: variant.id,
        name: variant.name,
        sortOrder: variant.sortOrder,
        priceMinor: price ? Number(price.priceMinor) : null,
        currency: price?.currency ?? null,
      }
    }),
  )

  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    shortName: item.shortName,
    photoUrl: item.photoUrl,
    nameHindi: item.nameHindi,
    vegMarker: item.vegMarker,
    available: resolveAvailability(item, outletId),
    priceMinor,
    currency,
    variants,
    modifierGroups: item.modifierGroups.map((link) => ({
      id: link.group.id,
      name: link.group.name,
      minSelections: link.group.minSelections,
      maxSelections: link.group.maxSelections,
      modifiers: link.group.modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.priceMinor) })),
    })),
    allergens: item.allergens.map((link) => ({ id: link.allergen.id, name: link.allergen.name })),
  }
}

@Injectable()
export class GuestMenuService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async getMenu(guest: GuestPrincipal): Promise<GuestMenuView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const categories = await tx.menuCategory.findMany({
        where: { tenantId: guest.tenantId },
        include: { items: { include: ITEM_INCLUDE, orderBy: { createdAt: 'asc' } } },
        orderBy: { sortOrder: 'asc' },
      })

      const categoryViews: MenuCategoryView[] = await Promise.all(
        categories.map(async (category) => ({
          id: category.id,
          name: category.name,
          sortOrder: category.sortOrder,
          items: await Promise.all(category.items.map((item) => toItemView(tx, guest.tenantId, guest.outletId, item))),
        })),
      )

      return { outletId: guest.outletId, categories: categoryViews }
    })
  }

  async getItem(guest: GuestPrincipal, itemId: string): Promise<MenuItemView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const item = await tx.menuItem.findUnique({ where: { id: itemId }, include: ITEM_INCLUDE })
      if (!item || item.tenantId !== guest.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such menu item' })
      }
      return toItemView(tx, guest.tenantId, guest.outletId, item)
    })
  }
}
