// pos/CAP-10 shift & cash management. staffId/tenantId are never accepted
// from the request body - they come from the signed-in pos session (same
// posture as every admin DTO not accepting tenantId), same as AD-5.
import { IsIn, IsInt, IsNotEmpty, IsString, IsUUID, MaxLength, Min } from 'class-validator'

export class OpenShiftDto {
  @IsUUID()
  outletId!: string

  // The starting float - zero is a valid (if unusual) float, so Min(0) not
  // Min(1).
  @IsInt() @Min(0)
  floatMinor!: number
}

export const CASH_MOVEMENT_TYPES = ['paid_out', 'bank_drop'] as const
export type CashMovementTypeValue = (typeof CASH_MOVEMENT_TYPES)[number]

export class LogCashMovementDto {
  @IsIn(CASH_MOVEMENT_TYPES)
  type!: CashMovementTypeValue

  // A movement is a real cash event - zero or negative isn't one.
  @IsInt() @Min(1)
  amountMinor!: number

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class CloseShiftDto {
  // The blind count - never optional, never defaulted. Zero is a valid
  // (empty till) count.
  @IsInt() @Min(0)
  countedMinor!: number
}
