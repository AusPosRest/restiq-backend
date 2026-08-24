import { Type } from 'class-transformer'
import { IsArray, IsInt, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator'

export class CreateModifierDto {
  @IsString() @MinLength(1)
  name!: string

  @IsOptional() @IsInt()
  priceMinor?: number
}

export class CreateModifierGroupDto {
  @IsString() @MinLength(1)
  name!: string

  @IsInt() @Min(0)
  minSelections!: number

  @IsInt() @Min(0)
  maxSelections!: number

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CreateModifierDto)
  modifiers?: CreateModifierDto[]
}

export class UpdateModifierGroupDto {
  @IsOptional() @IsString() @MinLength(1)
  name?: string

  @IsOptional() @IsInt() @Min(0)
  minSelections?: number

  @IsOptional() @IsInt() @Min(0)
  maxSelections?: number
}

export interface ModifierView {
  id: string
  name: string
  priceMinor: number
}

export interface ModifierGroupView {
  id: string
  name: string
  minSelections: number
  maxSelections: number
  modifiers: ModifierView[]
}
