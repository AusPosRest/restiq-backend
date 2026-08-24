// CAP-7 staff & roles. tenantId is never accepted from the request body - it
// comes from the signed-in owner's session (AD-5), same posture as every
// other admin DTO. roleId is validated against the tenant's seeded roles in
// the service, not here - the DTO only checks shape.
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator'

export class CreateStaffDto {
  @IsString() @MinLength(1) @MaxLength(200)
  name!: string

  @IsOptional() @IsEmail()
  email?: string

  @IsUUID()
  roleId!: string
}

export class UpdateStaffDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  name?: string

  @IsOptional() @IsUUID()
  roleId?: string

  // Required only when roleId is present (checked in the service, not here -
  // a plain rename carries no reason). Per SPEC's Constraints: role change is
  // named alongside PIN revoke and price change as security-relevant.
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500)
  reason?: string
}

export class RevokePinDto {
  // Required per AD-6: PIN revoke is security-relevant and must carry an
  // audited reason, unlike routine staff-list edits.
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}
