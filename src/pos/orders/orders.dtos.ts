import { ArrayUnique, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator'
import type { OrderStatus } from '../../generated/prisma/client'

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
  ownerId: string
  status: OrderStatus
  createdAt: string
  updatedAt: string
  lines: OrderLineView[]
}

// pos/CAP-3 order lines. Built against the real menu catalogue (itemId/
// variantId point straight at MenuItem/ItemVariant, modifierIds at Modifier)
// - see restiq-backend/src/admin/menu for those models' actual shape.
export class AddOrderLineDto {
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
// "remove this line, add a different one", not an edit (SPEC/stories.yaml
// story 4: PATCH covers "change quantity, or re-select modifiers before the
// order is sent"). Omitting modifierIds leaves the line's selections
// untouched; passing (possibly empty) modifierIds replaces them wholesale,
// re-validated the same way as on add.
export class UpdateOrderLineDto {
  @IsOptional() @IsInt() @Min(1)
  quantity?: number

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierIds?: string[]
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
  addedByStaffId: string
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
