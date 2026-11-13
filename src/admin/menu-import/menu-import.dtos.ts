import { Type } from 'class-transformer'
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator'
import type { DraftFieldConfidence, MenuImportSourceType } from './extraction'

export class PatchDraftItemDto {
  @IsUUID()
  id!: string

  @IsOptional() @IsString()
  name?: string

  @IsOptional() @IsString()
  shortName?: string

  @IsOptional() @IsString()
  category?: string

  @IsOptional() @IsInt() @Min(0)
  priceMinor?: number

  @IsOptional() @IsString()
  currency?: string
}

export class PatchMenuImportDraftDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PatchDraftItemDto)
  items!: PatchDraftItemDto[]

  // Rows the owner drops before commit, e.g. ones already on the menu (restiq-web#247).
  @IsOptional() @IsArray() @IsUUID('all', { each: true })
  removeIds?: string[]
}

export interface DraftItemView {
  id: string
  name: string
  shortName: string
  category: string
  priceMinor: number
  currency: string
  confidence: DraftFieldConfidence
  /** PE-11: on_menu = already on the menu in that category; repeated = earlier in this import. Commit refuses either. */
  duplicate: 'on_menu' | 'repeated' | null
}

export interface MenuImportDraftView {
  importId: string
  status: 'draft' | 'committed'
  sourceType: MenuImportSourceType
  fileName: string
  items: DraftItemView[]
}

export interface MenuImportCommitResult {
  importId: string
  committedAt: string
  categories: Array<{ id: string; name: string }>
  items: Array<{
    id: string
    name: string
    shortName: string
    categoryId: string
    price: { id: string; priceMinor: number; currency: string }
  }>
}
