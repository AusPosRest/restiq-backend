// Mutation payloads for Tenant Detail. Every one carries a required reason
// (AD-6) - a reasonless mutation never reaches a service method.
import { IsEmail, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator'

class MutationDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class UpdateTenantDto extends MutationDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500)
  registeredAddress?: string

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  contactName?: string

  @IsOptional() @IsEmail()
  contactEmail?: string

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(30)
  contactPhone?: string
}

export class UpdateBrandingDto extends MutationDto {
  // Flat string->string map; shape-checked in the service (class-validator
  // cannot express "every value is a string").
  @IsObject()
  tokens!: Record<string, unknown>
}

export class ReasonDto extends MutationDto {}
