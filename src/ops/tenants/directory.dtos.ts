// Mutation payloads for Tenant Detail. Every one carries a required reason
// (AD-6) - a reasonless mutation never reaches a service method.
import { IsBoolean, IsEmail, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator'

export const CAPABILITY_KEYS = [
  'tables_floor_plan',
  'kot_kds',
  'coursing',
  'aggregators',
  'reservations',
  'self_order_qr',
] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

/** Platform defaults; a tenant_capabilities row overrides its key. */
export const CAPABILITY_DEFAULTS: Readonly<Record<CapabilityKey, boolean>> = {
  tables_floor_plan: true,
  kot_kds: true,
  coursing: false,
  aggregators: false,
  reservations: false,
  self_order_qr: false,
}

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

export class ToggleCapabilityDto extends MutationDto {
  @IsBoolean()
  enabled!: boolean
}

export class UpdateBrandingDto extends MutationDto {
  // Flat string->string map; shape-checked in the service (class-validator
  // cannot express "every value is a string").
  @IsObject()
  tokens!: Record<string, unknown>
}

export class ReasonDto extends MutationDto {}
