import { Type } from 'class-transformer'
import { ArrayUnique, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min, MinLength, ValidateNested } from 'class-validator'
import type { PriceChannel, VegMarker } from '../../generated/prisma/client'
import { AllergenView } from './allergens.dtos'
import { ModifierGroupView } from './modifier-groups.dtos'

const PRICE_CHANNELS = ['dine_in', 'takeaway', 'delivery', 'qr', 'aggregator'] as const
const VEG_MARKERS = ['veg', 'non_veg'] as const

export class CreateVariantDto {
  @IsString() @MinLength(1)
  name!: string

  @IsOptional() @IsInt() @Min(0)
  sortOrder?: number
}

export class CreateItemDto {
  @IsUUID()
  categoryId!: string

  @IsString() @MinLength(1)
  name!: string

  @IsString() @MinLength(1)
  shortName!: string

  @IsOptional() @IsString() @MaxLength(2048)
  photoUrl?: string

  @IsOptional() @IsString() @MinLength(1)
  nameHindi?: string

  @IsOptional() @IsEnum(VEG_MARKERS)
  vegMarker?: VegMarker

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreateVariantDto)
  variants?: CreateVariantDto[]

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierGroupIds?: string[]

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  allergenIds?: string[]

  // kitchen-display/CAP-1 (AD-16): nullable kitchen-station routing, additive
  // to the already-shipped item shape. Omitted/null = unrouted - the kitchen
  // fire hook falls back to the outlet's default/expo station at fire time.
  @IsOptional() @IsUUID()
  stationId?: string
}

export class UpdateItemDto {
  @IsOptional() @IsString() @MinLength(1)
  name?: string

  @IsOptional() @IsString() @MinLength(1)
  shortName?: string

  @IsOptional() @IsUUID()
  categoryId?: string

  @IsOptional() @IsString() @MaxLength(2048)
  photoUrl?: string

  @IsOptional() @IsString() @MinLength(1)
  nameHindi?: string

  @IsOptional() @IsEnum(VEG_MARKERS)
  vegMarker?: VegMarker
}

// A separate PATCH than UpdateItemDto (mirrors SetAvailabilityDto's own
// dedicated endpoint below) so routing can be cleared back to null - a plain
// optional field on UpdateItemDto can only ever set a new value, never null
// it back out.
export class SetStationDto {
  @IsOptional() @IsUUID()
  stationId?: string
}

export class SetAvailabilityDto {
  @IsBoolean()
  available!: boolean
}

export class ReplaceModifierGroupsDto {
  @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierGroupIds!: string[]
}

export class ReplaceAllergensDto {
  @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  allergenIds!: string[]
}

// AD-6: price change is one of the SPEC's named security-relevant actions
// (role change, PIN revoke, price change) - unlike routine content edits
// (category/item/modifier-group CRUD), it requires a reason.
export class CreatePriceDto {
  @IsOptional() @IsUUID()
  variantId?: string

  @IsEnum(PRICE_CHANNELS)
  channel!: PriceChannel

  @IsOptional() @IsUUID()
  outletId?: string

  @IsInt() @Min(0)
  priceMinor!: number

  @Length(3, 3)
  currency!: string

  // Null/omitted = immediate. A future ISO timestamp schedules the change.
  @IsOptional() @IsDateString()
  effectiveAt?: string

  @IsString() @MinLength(1)
  reason!: string
}

export class CurrentPriceQueryDto {
  @IsEnum(PRICE_CHANNELS)
  channel!: PriceChannel

  @IsOptional() @IsUUID()
  variantId?: string

  @IsOptional() @IsUUID()
  outletId?: string
}

export class SetOutletAvailabilityDto {
  @IsBoolean()
  available!: boolean
}

export interface VariantView {
  id: string
  name: string
  sortOrder: number
}

export interface ItemView {
  id: string
  categoryId: string
  name: string
  shortName: string
  photoUrl: string | null
  nameHindi: string | null
  vegMarker: VegMarker | null
  available: boolean
  stationId: string | null
  variants: VariantView[]
  modifierGroups: ModifierGroupView[]
  allergens: AllergenView[]
}

export interface ItemPriceView {
  id: string
  itemId: string
  variantId: string | null
  channel: PriceChannel | null
  outletId: string | null
  priceMinor: number
  currency: string
  effectiveAt: string
  createdAt: string
}

export interface CurrentPriceView {
  itemId: string
  variantId: string | null
  channel: PriceChannel
  outletId: string | null
  priceMinor: number
  currency: string
  effectiveAt: string
}
