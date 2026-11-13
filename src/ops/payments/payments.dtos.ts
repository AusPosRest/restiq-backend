// #282 restaurant payments settings. A change always carries a reason (audited, AD-6).
import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator'

export const PAYMENT_METHODS = ['card', 'apple_pay', 'google_pay'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export class UpdatePaymentsDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsIn(PAYMENT_METHODS, { each: true })
  allowedMethods?: PaymentMethod[]

  @IsOptional() @IsInt() @Min(0) @Max(10_000)
  feePercentBps?: number

  // A string so minor units never lose precision; 15 digits keeps it inside a bigint column.
  @IsOptional() @IsString() @Matches(/^\d{1,15}$/, { message: 'feeFixedMinor must be a non-negative whole number of minor units' })
  feeFixedMinor?: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}
