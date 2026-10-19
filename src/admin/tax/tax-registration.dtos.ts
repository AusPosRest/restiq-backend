import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import type { GstSplitRounding } from '../../generated/prisma/client'

type TaxRegistrationType = 'gstin' | 'abn'

const GST_SPLIT_ROUNDINGS: readonly GstSplitRounding[] = ['exact_total', 'equal_half_up', 'equal_half_even']

export class UpdateTaxRegistrationDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  registrationNumber?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legalEntityName?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  taxProfile?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fssaiLicense?: string

  @IsOptional()
  @IsBoolean()
  compositionScheme?: boolean

  @IsOptional()
  @IsBoolean()
  gstRegistered?: boolean

  // Only meaningful when gstRegistered !== false - the service rejects it
  // otherwise.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  gstRatePercent?: number

  // India CGST/SGST odd-paisa rule (restiq-backend#244); stored for any
  // tenant but only applied to an IN CGST/SGST split.
  @IsOptional()
  @IsIn(GST_SPLIT_ROUNDINGS)
  gstSplitRounding?: GstSplitRounding
}

export interface TaxRegistrationView {
  country: string
  registrationType: TaxRegistrationType
  registrationNumber: string | null
  legalEntityName: string
  taxProfile: string
  fssaiLicense: string | null
  compositionScheme: boolean
  gstRegistered: boolean
  gstRatePercent: number | null
  gstSplitRounding: GstSplitRounding
}
