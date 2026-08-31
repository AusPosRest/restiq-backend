import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Min, MinLength, ValidateNested } from 'class-validator'

export class ComboComponentDto {
  @IsUUID()
  itemId!: string

  @IsOptional() @IsInt() @Min(1)
  quantity?: number
}

export class CreateComboDto {
  @IsString() @MinLength(1)
  name!: string

  @IsOptional() @IsUUID()
  categoryId?: string

  @IsInt() @Min(0)
  priceMinor!: number

  @Length(3, 3)
  currency!: string

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ComboComponentDto)
  components!: ComboComponentDto[]
}

export interface ComboView {
  id: string
  name: string
  categoryId: string | null
  priceMinor: number
  currency: string
  components: Array<{ itemId: string; quantity: number }>
}
