// qr-self-order/CAP-2 (stories.yaml story 2, issue #78): the guest-readable projection
// shape. Mirrors the real catalogue (admin/menu) including guest-facing fields:
// photoUrl, nameHindi, and vegMarker.
import type { VegMarker } from '../../generated/prisma/client'

export interface MenuModifierView {
  id: string
  name: string
  priceMinor: number
}

export interface MenuModifierGroupView {
  id: string
  name: string
  minSelections: number
  maxSelections: number
  modifiers: MenuModifierView[]
}

export interface MenuAllergenView {
  id: string
  name: string
}

export interface MenuVariantView {
  id: string
  name: string
  sortOrder: number
  // null when no current price is configured for this variant (mirrors
  // pos/order-lines' own "no_price" possibility - never invented as 0).
  priceMinor: number | null
  currency: string | null
}

export interface MenuItemView {
  id: string
  categoryId: string
  name: string
  shortName: string
  photoUrl: string | null
  nameHindi: string | null
  vegMarker: VegMarker | null
  // Tenant-wide 86 toggle combined with this outlet's override row, if any
  // (CAP-2 success criterion: an 86'd item is included, marked unavailable).
  available: boolean
  // Populated only for items with no variants (AD-11: an item's price and
  // its variants' prices never mix). null when unpriced.
  priceMinor: number | null
  currency: string | null
  variants: MenuVariantView[]
  modifierGroups: MenuModifierGroupView[]
  allergens: MenuAllergenView[]
}

export interface MenuCategoryView {
  id: string
  name: string
  sortOrder: number
  items: MenuItemView[]
}

export interface GuestMenuView {
  outletId: string
  categories: MenuCategoryView[]
}
