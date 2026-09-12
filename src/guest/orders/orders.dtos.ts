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
  // null for a kiosk order (issue #138), which carries tokenNumber instead.
  tableId: string | null
  status: 'sent'
  source: 'qr' | 'kiosk'
  tokenNumber: number | null
  sessionId: string
  lines: PlacedOrderLineView[]
}

// qr-self-order/CAP-6 (issue #81): the guest status stepper's server-derived
// shape - see orders.service.ts's buildOrderStatusView for the honest
// placed/accepted/preparing/ready mapping off the real Ticket model (SPEC
// CAP-6: "the stepper never shows a state the ticket data doesn't support").
export type GuestOrderStep = 'placed' | 'accepted' | 'preparing' | 'ready'

export interface GuestOrderStepView {
  step: GuestOrderStep
  // ISO timestamp the step was reached, or null while not yet reached - never
  // fabricated (e.g. 'preparing' before any ticket has fired).
  reachedAt: string | null
}

export interface GuestOrderStatusView {
  orderId: string
  // Nullable in the schema (a counter/token order has no table) - always
  // present for a qr-source order in practice, since guest placement always
  // sets it from the table session, but the type stays honest to Order's own.
  tableId: string | null
  // Set for a kiosk order (issue #138) - the pickup number the counter calls.
  tokenNumber: number | null
  // The furthest step this order has reached - what the stepper highlights.
  step: GuestOrderStep
  steps: GuestOrderStepView[]
}

export interface GuestSessionOrdersView {
  sessionId: string
  orders: GuestOrderStatusView[]
}
