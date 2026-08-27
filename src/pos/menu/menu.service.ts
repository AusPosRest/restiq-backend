// pos/CAP-3's menu read (restiq-backend#66). Reuses tenant-admin/CAP-4's real
// schema and price-resolution logic wholesale - MenuCategory/MenuItem/
// ItemVariant/ModifierGroup/Modifier/ItemOutletOverride (see
// src/admin/menu/items.service.ts's ITEM_INCLUDE for the include shape this
// mirrors) and resolveCurrentPrice (src/admin/menu/pricing.ts, exported from
// the admin barrel specifically for pos/CAP-3 reuse - order-lines.service.ts
// already calls it the same way when a line is added). No second
// price-picking or menu-shape implementation.
import { Injectable } from '@nestjs/common'
import { resolveCurrentPrice } from '../../admin'
import type { PriceChannel, Prisma } from '../../generated/prisma/client'
import { PosPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { MenuItemView, MenuVariantView, MenuView } from './menu.dtos'

// Fixed, same posture as order-lines.service.ts's ORDER_PRICE_CHANNEL: there
// is no channel column on Order yet for CAP-6 counter mode to pick a
// different price - the menu a staff member browses must show the same
// price a line will actually be snapshotted at on add.
const MENU_PRICE_CHANNEL: PriceChannel = 'dine_in'
const DEFAULT_CURRENCY = 'INR'

const ITEM_INCLUDE = {
  variants: { orderBy: { sortOrder: 'asc' } },
  modifierGroups: { include: { group: { include: { modifiers: { orderBy: { sortOrder: 'asc' } } } } } },
} satisfies Prisma.MenuItemInclude

type ItemWithRelations = Prisma.MenuItemGetPayload<{ include: typeof ITEM_INCLUDE }>

@Injectable()
export class MenuService {
  constructor(private readonly registry: RegionRegistryService) {}

  async getMenu(staff: PosPrincipal): Promise<MenuView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)

      const [categories, items, overrides] = await Promise.all([
        tx.menuCategory.findMany({ where: { tenantId: staff.tenantId }, orderBy: { sortOrder: 'asc' } }),
        tx.menuItem.findMany({ where: { tenantId: staff.tenantId }, include: ITEM_INCLUDE, orderBy: { createdAt: 'asc' } }),
        tx.itemOutletOverride.findMany({ where: { tenantId: staff.tenantId, outletId: staff.outletId } }),
      ])
      const availabilityOverride = new Map(overrides.map((o) => [o.itemId, o.available]))

      let currency = DEFAULT_CURRENCY
      const itemViews: MenuItemView[] = []
      for (const item of items) {
        const { priceMinor, variants, currency: itemCurrency } = await this.resolvePricing(tx, staff, item)
        if (itemCurrency) currency = itemCurrency

        // An item with nothing purchasable - no base price and no variants
        // (either it never had one, or every variant's own price was
        // individually dropped above) - is dropped entirely, not shown with
        // a fabricated ₹0. Matches this file's header comment; this is the
        // item-level half of that rule, resolvePricing already covers the
        // per-variant half.
        const hasPurchasablePrice = item.variants.length === 0 ? priceMinor !== null : variants.length > 0
        if (!hasPurchasablePrice) continue

        itemViews.push({
          id: item.id,
          categoryId: item.categoryId,
          name: item.name,
          shortName: item.shortName,
          available: availabilityOverride.get(item.id) ?? item.available,
          priceMinor,
          variants,
          modifierGroups: item.modifierGroups.map((link) => ({
            id: link.group.id,
            name: link.group.name,
            minSelections: link.group.minSelections,
            maxSelections: link.group.maxSelections,
            modifiers: link.group.modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.priceMinor) })),
          })),
        })
      }

      return { categories: categories.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder })), items: itemViews, currency }
    })
  }

  // A variant (or a variant-less item) with no resolvable current price is
  // dropped rather than shown with a fabricated ₹0 - same "never a
  // fabricated real zero" posture this codebase already holds elsewhere
  // (e.g. pos/open-orders' summarize()) for a genuinely missing figure.
  private async resolvePricing(
    tx: Prisma.TransactionClient,
    staff: PosPrincipal,
    item: ItemWithRelations,
  ): Promise<{ priceMinor: number | null; variants: MenuVariantView[]; currency: string | null }> {
    if (item.variants.length === 0) {
      const price = await resolveCurrentPrice(tx, { tenantId: staff.tenantId, itemId: item.id, variantId: null, channel: MENU_PRICE_CHANNEL, outletId: staff.outletId })
      return { priceMinor: price ? Number(price.priceMinor) : null, variants: [], currency: price?.currency ?? null }
    }

    const variants: MenuVariantView[] = []
    let currency: string | null = null
    for (const variant of item.variants) {
      const price = await resolveCurrentPrice(tx, { tenantId: staff.tenantId, itemId: item.id, variantId: variant.id, channel: MENU_PRICE_CHANNEL, outletId: staff.outletId })
      if (!price) continue
      variants.push({ id: variant.id, name: variant.name, priceMinor: Number(price.priceMinor) })
      currency = price.currency
    }
    return { priceMinor: null, variants, currency }
  }
}
