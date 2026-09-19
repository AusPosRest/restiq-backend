// restiq-backend#160: owner combo editing. A combo is saved whole - name,
// price and every slot - so the editor never has to reconcile partial slot
// edits against orders already carrying the combo.
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'
import type { ComboMenuView } from './combo-menu'

// Same rule as a menu item photo: an https URL or a small inline image.
const PHOTO_URL = /^(https:\/\/\S{1,2040}|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2})$/
const PHOTO_URL_MESSAGE = 'photoUrl must be an https URL or a data:image (jpeg, png or webp) photo under 200 KB'

// One pick inside a combo when ordering - a ComboSlotOption, how many of
// it, and that item's own modifiers. Used by the POS and the guest cart.
export class ComboSelectionDto {
  @IsUUID()
  optionId!: string

  @IsOptional() @IsInt() @Min(1)
  quantity?: number

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  modifierIds?: string[]
}

export class ComboSlotOptionDto {
  @IsUUID()
  itemId!: string

  @IsOptional() @IsUUID()
  variantId?: string

  @IsOptional() @IsInt() @Min(0)
  upchargeMinor?: number
}

export class ComboSlotDto {
  @IsString() @MinLength(1) @MaxLength(60)
  name!: string

  @IsInt() @Min(1)
  pickCount!: number

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ComboSlotOptionDto)
  options!: ComboSlotOptionDto[]
}

export class SaveComboDto {
  @IsString() @MinLength(1) @MaxLength(80)
  name!: string

  @IsOptional() @IsUUID()
  categoryId?: string

  @IsInt() @Min(0)
  priceMinor!: number

  @Length(3, 3)
  currency!: string

  @IsOptional() @IsString() @MaxLength(280_000) @Matches(PHOTO_URL, { message: PHOTO_URL_MESSAGE })
  photoUrl?: string

  @IsOptional() @IsBoolean()
  available?: boolean

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => ComboSlotDto)
  slots!: ComboSlotDto[]
}

export type ComboView = ComboMenuView
