import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator'

export const PLAN_COUNTRIES = ['AU', 'IN'] as const
export const PLANS = ['standard', 'enterprise'] as const

export interface PlanPriceView {
  country: (typeof PLAN_COUNTRIES)[number]
  plan: (typeof PLANS)[number]
  /** Per outlet per month in minor units (cents/paise); null = on quote. */
  monthlyPriceMinor: number | null
  annualDiscountPercent: number
  currency: 'AUD' | 'INR'
  updatedAt: string
}

export class UpdatePlanPriceDto {
  @ValidateIf((_, value) => value !== null) @IsInt() @Min(0) @Max(100_000_000)
  monthlyPriceMinor!: number | null

  @IsInt() @Min(0) @Max(100)
  annualDiscountPercent!: number

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}
