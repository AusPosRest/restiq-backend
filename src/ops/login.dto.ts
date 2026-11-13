import { Transform, TransformFnParams } from 'class-transformer'
import { IsEmail, IsString, MinLength } from 'class-validator'

export class LoginDto {
  @Transform(({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string

  @IsString()
  @MinLength(1)
  password!: string
}
