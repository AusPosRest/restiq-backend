// CAP-4 device fleet payloads. Hub designation and revoke always carry a
// required reason (AD-6); code generation and enroll default one (matches
// the wizard-submit pattern - the O6 render collects no reason for either).
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator'

export const DEVICE_TYPES = ['pos', 'kds', 'kiosk', 'cds'] as const
export type DeviceTypeValue = (typeof DEVICE_TYPES)[number]

export const DEVICE_STATUSES = ['active', 'revoked'] as const
export const DEVICE_ROLES = ['terminal', 'hub'] as const

class MutationDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class GenerateCodeDto {
  @IsUUID()
  tenantId!: string

  @IsUUID()
  outletId!: string

  @IsIn(DEVICE_TYPES)
  deviceType!: DeviceTypeValue

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string
}

export class EnrollDeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(20)
  code!: string

  @IsString() @IsNotEmpty() @MaxLength(200)
  hardwareKeyFingerprint!: string

  @IsOptional() @IsString() @MaxLength(100)
  label?: string

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string
}

export class HubDto extends MutationDto {}
export class RevokeDto extends MutationDto {}
