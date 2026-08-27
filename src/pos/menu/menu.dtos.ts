// pos/CAP-3's menu read (restiq-backend#66). Response shape matches what
// restiq-web's order-taking-state.ts already declares as PosMenuView - that
// contract was never wrong, just never backed by a real endpoint (this file
// closes that gap; restiq-web needs no shape change here).

export interface MenuVariantView {
  id: string
  name: string
  priceMinor: number
}

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

export interface MenuItemView {
  id: string
  categoryId: string
  name: string
  shortName: string
  available: boolean
  /** Base price when the item has no variants; null when priced per-variant (see variants[].priceMinor instead). */
  priceMinor: number | null
  variants: MenuVariantView[]
  modifierGroups: MenuModifierGroupView[]
}

export interface MenuCategoryView {
  id: string
  name: string
  sortOrder: number
}

export interface MenuView {
  categories: MenuCategoryView[]
  items: MenuItemView[]
  currency: string
}
