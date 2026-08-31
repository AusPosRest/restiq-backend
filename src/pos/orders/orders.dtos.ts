import { ArrayUnique, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator'
import type { OrderSource, OrderStatus } from '../../generated/prisma/client'

const ORDER_STATUSES = ['open', 'sent', 'closed'] as const

export class UpdateOrderStatusDto {
  @IsEnum(ORDER_STATUSES)
  status!: OrderStatus
}

// reason is optional - per SPEC (stories.yaml story 3), transfer isn't one of
// CAP-8's six manager-gated actions, so no PIN/reason requirement applies.
// It's still audited (AD-6) with a fixed placeholder when omitted, since
// audit_events.reason is NOT NULL.
export class TransferOrderDto {
  @IsUUID()
  newOwnerStaffId!: string

  @IsOptional() @IsString() @MinLength(1)
  reason?: string
}

export interface OrderView {
  id: string
  tenantId: string
  outletId: string
  tableId: string | null
  // Nullable as of qr-self-order/CAP-4 (issue #77): null only for a
  // guest-placed (source 'qr') order that no staff member has yet taken over
  // via transfer() - see Order.ownerId's schema comment.
  ownerId: string | null
  status: OrderStatus
  // pos/CAP-6 (issue #62): null on every table (dine-in) order; a real,
  // gapless-per-outlet sequential number on a counter order (tableId null),
  // assigned at creation - see orders.service.ts's createCounterOrder.
  tokenNumber: number | null
  // qr-self-order/CAP-4 (AD-18): 'pos' for every staff-created order (the
  // default), 'qr' for one placed from a guest table session - see
  // guest/orders/orders.service.ts's placeOrder. Consumers render both alike,
  // this field is display-only (AD-18: "zero special-casing beyond
  // displaying the labels").
  source: OrderSource
  // The guest TableSession this order was placed from - null for every
  // pos-source order.
  sessionId: string | null
  createdAt: string
  updatedAt: string
  lines: OrderLineView[]
}

// pos/CAP-3 order lines. Built against the real menu catalogue (itemId/
// variantId point straight at MenuItem/ItemVariant, modifierIds at Modifier)
// - see restiq-backend/src/admin/menu for those models' actual shape.
//
// seatNumber (pos/CAP-4, issue #58) is optional here - group ordering is not
// mandatory for every order, only orders that use it must have every line
// seated before they can be sent (see orders.service.ts's updateStatus).
export class AddOrderLineDto {
  @IsUUID()
  itemId!: string

  @IsOptional() @IsUUID()
  variantId?: string

  @IsInt() @Min(1)
  quantity!: number

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierIds?: string[]

  @IsOptional() @IsInt() @Min(1)
  seatNumber?: number
}

// Quantity, seat number, and/or modifier re-selection only - swapping
// itemId/variantId is "remove this line, add a different one", not an edit
// (SPEC/stories.yaml story 4: PATCH covers "change quantity, or re-select
// modifiers before the order is sent"). Omitting modifierIds leaves the
// line's selections untouched; passing (possibly empty) modifierIds replaces
// them wholesale, re-validated the same way as on add. Omitting seatNumber
// leaves it untouched too (pos/CAP-4, issue #58).
export class UpdateOrderLineDto {
  @IsOptional() @IsInt() @Min(1)
  quantity?: number

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierIds?: string[]

  @IsOptional() @IsInt() @Min(1)
  seatNumber?: number
}

export interface OrderLineModifierView {
  id: string
  modifierId: string
  name: string
  priceMinor: number
}

export interface OrderLineView {
  id: string
  orderId: string
  itemId: string
  variantId: string | null
  quantity: number
  // Snapshotted at add-time (and re-snapshotted only by an explicit PATCH) -
  // a later item_prices change never retroactively alters this line.
  unitPriceMinor: number
  // pos/CAP-4 (issue #58): null until group ordering assigns this line to a
  // seat/cover. Every line on an order must carry one before that order can
  // move to "sent" - see orders.service.ts's updateStatus.
  seatNumber: number | null
  // Nullable as of qr-self-order/CAP-4 (issue #77): null for a guest-placed
  // line, which has no staff adder - see guestId/guestName instead.
  addedByStaffId: string | null
  // qr-self-order/CAP-4 (AD-18): the guest who added this line via the
  // shared cart, carried over at placement - null for every pos-added line.
  // guestName is a snapshot (same posture as CartLineView's), not a live
  // Guest lookup.
  guestId: string | null
  guestName: string | null
  createdAt: string
  modifiers: OrderLineModifierView[]
}

export type TableMapStatus = 'occupied' | 'empty'

export interface TableMapEntry {
  tableId: string
  floorId: string
  label: string
  seatCapacity: number
  // TODO(pos/CAP-7 Bill and settle): SPEC's third state, "needs-bill", is
  // defined by whether a Bill has been requested for the table's order - the
  // Bill model doesn't exist yet (AD-14 introduces it in a later story). Once
  // it does, this union grows a third member and getTableMap() reads Bill
  // state the same way it reads Order state below.
  status: TableMapStatus
  orderId: string | null
  ownerId: string | null
}
