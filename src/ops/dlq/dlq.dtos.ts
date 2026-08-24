// CAP-7 dead-letter queue payloads. Replay always carries a required reason
// (AD-6, same MutationDto pattern as devices.dtos.ts) - single and bulk alike.
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator'

export class ReplayDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

// Bulk replay takes either an explicit id list or a filter (same shape as the
// list query) - never both, never neither; the service enforces that.
export class BulkReplayDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string

  @IsOptional() @IsArray() @ArrayNotEmpty() @IsUUID('all', { each: true })
  ids?: string[]

  @IsOptional() @IsUUID()
  tenantId?: string

  @IsOptional() @IsUUID()
  deviceId?: string

  @IsOptional() @IsString() @MaxLength(100)
  reasonCode?: string
}
