// qr-self-order/CAP-3 (issue #72): the shared table cart's request/response
// shapes. Mirrors pos/orders/orders.dtos.ts's AddOrderLineDto/
// UpdateOrderLineDto validation shape (itemId/variantId/quantity/
// modifierIds) - same server-side rules, different destination (CartLine,
// not OrderLine, per CartLine's schema comment).
import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator'
import { ComboSelectionDto } from '../../admin'

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

// restiq-backend#160: a combo with its picks, same shape as the POS's
// AddComboLineDto minus the seat (a guest's seat is assigned at placement).
export class AddCartComboDto {
  @IsUUID()
  comboId!: string

  @IsInt() @Min(1)
  quantity!: number

  @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => ComboSelectionDto)
  selections!: ComboSelectionDto[]
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
  // Null on a combo line (restiq-backend#160) - itemName is then the
  // combo's name, components lists its picks, and the price and total
  // already include every pick's extra charge and modifiers.
  itemId: string | null
  comboId: string | null
  components: string[]
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
