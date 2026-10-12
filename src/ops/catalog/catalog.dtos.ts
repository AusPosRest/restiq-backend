import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator'
import type { VegMarker } from '../../generated/prisma/client'

const VEG_MARKERS = ['veg', 'non_veg'] as const
export const CATALOG_CURRENCIES = ['INR', 'AUD'] as const
export type CatalogCurrency = (typeof CATALOG_CURRENCIES)[number]

export class CreateCatalogProductDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string

  @IsString() @MinLength(1) @MaxLength(40)
  shortName!: string

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  nameHindi?: string | null

  @IsOptional() @IsEnum(VEG_MARKERS)
  vegMarker?: VegMarker | null

  // ponytail: https URL only, same bound as items.dtos on main; adopt the
  // data:image regex from #142 once that lands.
  @IsOptional() @IsString() @MaxLength(2048)
  photoUrl?: string | null

  @IsString() @MinLength(1) @MaxLength(60)
  category!: string

  @IsInt() @Min(0)
  suggestedPriceMinor!: number

  @IsIn(CATALOG_CURRENCIES)
  currency!: CatalogCurrency

  @IsOptional() @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(30, { each: true })
  tags?: string[]
}

// Every field optional; null clears the nullable ones.
export class UpdateCatalogProductDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string

  @IsOptional() @IsString() @MinLength(1) @MaxLength(40)
  shortName?: string

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  nameHindi?: string | null

  @IsOptional() @IsEnum(VEG_MARKERS)
  vegMarker?: VegMarker | null

  @IsOptional() @IsString() @MaxLength(2048)
  photoUrl?: string | null

  @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  category?: string

  @IsOptional() @IsInt() @Min(0)
  suggestedPriceMinor?: number

  @IsOptional() @IsIn(CATALOG_CURRENCIES)
  currency?: CatalogCurrency

  @IsOptional() @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(30, { each: true })
  tags?: string[]
}

export class ImportCatalogProductsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all', { each: true })
  productIds!: string[]
}

export interface CatalogProductView {
  id: string
  name: string
  shortName: string
  nameHindi: string | null
  vegMarker: VegMarker | null
  photoUrl: string | null
  category: string
  suggestedPriceMinor: number
  currency: string
  tags: string[]
  updatedAt: string
}

export interface CatalogListQuery {
  q?: string
  tag?: string
  currency?: string
}
