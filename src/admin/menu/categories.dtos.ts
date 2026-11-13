import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator'
import { NotBlank } from '../../platform'

export class CreateCategoryDto {
  @IsString() @NotBlank() @MaxLength(80)
  name!: string

  @IsOptional() @IsInt() @Min(0)
  sortOrder?: number
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @NotBlank() @MaxLength(80)
  name?: string

  @IsOptional() @IsInt() @Min(0)
  sortOrder?: number
}

export interface CategoryView {
  id: string
  name: string
  sortOrder: number
  itemCount: number
}
