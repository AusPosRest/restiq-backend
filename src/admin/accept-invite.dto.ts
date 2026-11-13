import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator'

// issue #193: the invite page reads who the invite is for before the owner sets a password.
export class InviteDetailsDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  token!: string
}

export class AcceptInviteDto {
  @IsString() @IsNotEmpty()
  token!: string

  // Owner-set credential, not an internal seed - held to a real minimum.
  @IsString() @MinLength(10) @MaxLength(200)
  password!: string
}
