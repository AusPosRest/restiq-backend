import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator'

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(254)
  email!: string
}

export class ResetPasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  token!: string

  // Same bar as accepting an invite: an owner-chosen credential, held to a real minimum.
  @IsString() @MinLength(10) @MaxLength(200)
  password!: string
}
