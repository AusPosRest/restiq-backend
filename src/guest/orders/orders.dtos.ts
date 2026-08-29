// qr-self-order/CAP-4 (issue #77): placement's response shape - the freshly
// created Order/OrderLine set, same fields pos/orders/orders.dtos.ts's
// OrderView/OrderLineView expose for a 'qr'-source order (duplicated per this
// workspace's existing convention of small, module-local view shapes rather
// than a cross-module import of pos-internal types - AD-2).
export interface PlacedOrderLineModifierView {
  id: string
  name: string
  priceMinor: number
}

export interface PlacedOrderLineView {
  id: string
  itemId: string
  itemName: string
  variantId: string | null
  variantName: string | null
  quantity: number
  unitPriceMinor: number
  seatNumber: number | null
  guestId: string
  guestName: string
  modifiers: PlacedOrderLineModifierView[]
}

export interface PlacedOrderView {
  orderId: string
  tableId: string
  status: 'sent'
  source: 'qr'
  sessionId: string
  lines: PlacedOrderLineView[]
}
