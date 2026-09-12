// CAP-6 devices & printers. tenantId/outletId are never accepted from the
// request body - they come from the signed-in owner's session and the
// :outletId path segment respectively (AD-5), unlike the ops-realm
// GenerateCodeDto which trusts an operator to name any tenant.
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator'
import { DEVICE_TYPES, DeviceTypeValue } from '../../ops'

// Device topology (issue #134): the POS a printer/terminal serves, or null
// to serve the whole outlet again.
export class AdminDevicePairingDto {
  @ValidateIf((_, value) => value !== null) @IsUUID()
  posDeviceId!: string | null
}

export class AdminGenerateCodeDto {
  @IsIn(DEVICE_TYPES)
  deviceType!: DeviceTypeValue

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string
}
