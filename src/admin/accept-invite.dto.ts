import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator'

export class AcceptInviteDto {
  @IsString() @IsNotEmpty()
  token!: string

  // Owner-set credential, not an internal seed - held to a real minimum.
  @IsString() @MinLength(10) @MaxLength(200)
  password!: string
}
