import { IsString, MinLength } from 'class-validator'

export class CreateAllergenDto {
  @IsString() @MinLength(1)
  name!: string
}

export interface AllergenView {
  id: string
  name: string
}
