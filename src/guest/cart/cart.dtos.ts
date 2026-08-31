// qr-self-order/CAP-3 (issue #72): the shared table cart's request/response
// shapes. Mirrors pos/orders/orders.dtos.ts's AddOrderLineDto/
// UpdateOrderLineDto validation shape (itemId/variantId/quantity/
// modifierIds) - same server-side rules, different destination (CartLine,
// not OrderLine, per CartLine's schema comment).
import { ArrayUnique, IsArray, IsInt, IsOptional, IsUUID, Min } from 'class-validator'

export class AddCartLineDto {
  @IsUUID()
  itemId!: string

  @IsOptional() @IsUUID()
  variantId?: string

  @IsInt() @Min(1)
  quantity!: number

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierIds?: string[]
}

// Quantity and/or modifier re-selection only - swapping itemId/variantId is
// "remove this line, add a different one", same posture as
// UpdateOrderLineDto. Omitting modifierIds leaves selections untouched;
// passing (possibly empty) modifierIds replaces them wholesale, re-validated
// the same way as on add.
export class UpdateCartLineDto {
  @IsOptional() @IsInt() @Min(1)
  quantity?: number

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierIds?: string[]
}

export interface CartLineModifierView {
  id: string
  name: string
  priceMinor: number
}

export interface CartLineView {
  id: string
  guestId: string
  guestName: string
  itemId: string
  itemName: string
  variantId: string | null
  variantName: string | null
  quantity: number
  // Resolved at read time against the live item_prices rows (AD-11) - never
  // snapshotted here, see CartLine's schema comment for why.
  unitPriceMinor: number
  modifiers: CartLineModifierView[]
  lineTotalMinor: number
  createdAt: string
}

export interface GuestCartView {
  guestId: string
  guestName: string
  lines: CartLineView[]
  subtotalMinor: number
}

export interface TableCartView {
  sessionId: string
  guests: GuestCartView[]
  totalMinor: number
  currency: string
}
