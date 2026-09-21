import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from 'class-validator'
import type { ClockEventType } from '../../generated/prisma/client'

// 4-digit PIN per SPEC CAP-1 and staff.service.ts's PIN_LENGTH convention.
const PIN_PATTERN = /^\d{4}$/

export class PosLoginDto {
  @IsUUID()
  tenantId!: string

  @Matches(PIN_PATTERN, { message: 'pin must be exactly 4 digits' })
  pin!: string

  // restiq-backend#171: the enrolled device this login comes from (the tab's
  // ?device= binding). Only trusted if it is an active device of this tenant;
  // otherwise the attempt is throttled by IP like any unbound browser.
  @IsOptional() @IsUUID()
  deviceId?: string
}

export class SelectOutletDto {
  @IsString() @IsNotEmpty()
  pendingToken!: string

  @IsUUID()
  outletId!: string
}

export interface StaffSummary {
  id: string
  name: string
}

export interface OutletSummary {
  id: string
  name: string
}

export type PosLoginResult =
  | { status: 'authenticated'; token: string; staff: StaffSummary; outlet: OutletSummary }
  | { status: 'select_outlet'; pendingToken: string; staff: StaffSummary; outlets: OutletSummary[] }

export interface ClockEventView {
  id: string
  type: ClockEventType
  occurredAt: string
}
