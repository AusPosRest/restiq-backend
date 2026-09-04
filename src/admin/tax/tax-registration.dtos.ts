import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator'

type TaxRegistrationType = 'gstin' | 'abn'

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
}
