// #286 card readers (Stripe Terminal) and reader orders. Money in minor units as strings on the wire.
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator'
import { NotBlank } from '../../platform'

export const READER_COUNTRIES = ['AU', 'IN'] as const
export const READER_MODELS = ['s700', 'wisepos_e'] as const
export type ReaderModelName = (typeof READER_MODELS)[number]
export const READER_ORDER_STATUSES = ['payment_failed', 'paid', 'ordered', 'shipped', 'delivered', 'cancelled'] as const
export type ReaderOrderStatusName = (typeof READER_ORDER_STATUSES)[number]

export interface ReaderPriceView {
  country: (typeof READER_COUNTRIES)[number]
  model: ReaderModelName
  displayName: string
  /** null = not for sale. */
  priceMinor: string | null
  currency: 'AUD' | 'INR'
  updatedAt: string
}

export interface CardReaderView {
  id: string
  outletId: string
  outletName: string
  label: string
  deviceType: string
  serialNumber: string
  status: 'online' | 'offline' | 'unknown'
  simulated: boolean
}

export interface ShippingAddress {
  name: string
  line1: string
  line2?: string
  city: string
  state: string
  postcode: string
  phone: string
}

export interface ReaderOrderView {
  id: string
  tenantId: string
  tenantName: string
  outletId: string
  outletName: string
  model: ReaderModelName
  displayName: string
  quantity: number
  unitPriceMinor: string
  totalMinor: string
  currency: string
  shipping: ShippingAddress
  status: ReaderOrderStatusName
  failureMessage: string | null
  trackingRef: string | null
  opsNote: string | null
  createdAt: string
  updatedAt: string
}

export class UpdateReaderPriceDto {
  @ValidateIf((_, value) => value !== null) @IsInt() @Min(0) @Max(100_000_000)
  priceMinor!: number | null

  @IsOptional() @IsString() @NotBlank() @MaxLength(100)
  displayName?: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class TerminalAddressDto {
  @IsString() @NotBlank() @MaxLength(200) line1!: string
  @IsString() @NotBlank() @MaxLength(100) city!: string
  @IsString() @NotBlank() @MaxLength(100) state!: string
  @IsString() @NotBlank() @MaxLength(20) postcode!: string
}

export class RegisterCardReaderDto {
  @IsUUID()
  outletId!: string

  @IsString() @NotBlank() @MaxLength(100)
  label!: string

  // A smart reader shows its code on screen (three words joined by dashes); `simulated-*` on a test key.
  @IsString() @NotBlank() @MaxLength(100)
  registrationCode!: string

  // Only needed for an outlet's first reader - it becomes the outlet's Stripe Terminal Location.
  @IsOptional() @IsObject() @ValidateNested() @Type(() => TerminalAddressDto)
  address?: TerminalAddressDto
}

export class RemoveCardReaderDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class ShippingDto implements ShippingAddress {
  @IsString() @NotBlank() @MaxLength(200) name!: string
  @IsString() @NotBlank() @MaxLength(200) line1!: string
  @IsOptional() @IsString() @MaxLength(200) line2?: string
  @IsString() @NotBlank() @MaxLength(100) city!: string
  @IsString() @NotBlank() @MaxLength(100) state!: string
  @IsString() @NotBlank() @MaxLength(20) postcode!: string
  @IsString() @NotBlank() @MaxLength(30) phone!: string
}

export class CreateReaderOrderDto {
  @IsUUID()
  outletId!: string

  @IsIn(READER_MODELS)
  model!: ReaderModelName

  @IsInt() @Min(1) @Max(5)
  quantity!: number

  @IsObject() @ValidateNested() @Type(() => ShippingDto)
  shipping!: ShippingDto
}

export const OPS_ORDER_STATUSES = ['ordered', 'shipped', 'delivered', 'cancelled'] as const

export class UpdateReaderOrderDto {
  @IsIn(OPS_ORDER_STATUSES)
  status!: (typeof OPS_ORDER_STATUSES)[number]

  @IsOptional() @IsString() @MaxLength(200)
  trackingRef?: string

  @IsOptional() @IsString() @MaxLength(1000)
  opsNote?: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class ListReaderOrdersQuery {
  @IsOptional() @IsIn(READER_ORDER_STATUSES)
  status?: ReaderOrderStatusName
}
