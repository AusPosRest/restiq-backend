// CAP-4 device fleet payloads. Hub designation and revoke always carry a
// required reason (AD-6); code generation and enroll default one (matches
// the wizard-submit pattern - the O6 render collects no reason for either).
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator'

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

// CAP-6 heartbeat: a device's latest telemetry snapshot. No payload body
// field exists here or anywhere on this DTO (NFR-15) - only sync metadata.
export class HeartbeatDto {
  @IsInt() @Min(0) @Max(100_000)
  outboxDepth!: number

  @IsString() @IsNotEmpty() @MaxLength(50)
  appVersion!: string

  @IsInt() @Min(-3600) @Max(3600)
  clockSkewSeconds!: number

  @IsInt() @Min(0) @Max(100_000)
  recentRejectionCount!: number
}
