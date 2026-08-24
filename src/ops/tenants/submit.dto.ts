// The full wizard payload, validated at final submit. Drafts are free-form
// (a half-finished step is legal in a draft); this DTO is the gate a payload
// must pass before provisioning runs.
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsDefined,
  ArrayMinSize,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator'

export const COUNTRIES = ['IN', 'AU'] as const
export const OUTLET_TYPES = ['dine_in', 'qsr', 'cloud_kitchen', 'food_court'] as const
export const PLANS = ['standard', 'enterprise'] as const
export const BILLING_PERIODS = ['monthly', 'annual'] as const

export class BusinessDetailsDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  companyName!: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  registeredAddress!: string

  @IsString() @IsNotEmpty() @MaxLength(200)
  contactName!: string

  @IsEmail()
  contactEmail!: string

  @IsString() @IsNotEmpty() @MaxLength(30)
  contactPhone!: string
}

export class TaxComplianceDto {
  @IsIn(COUNTRIES)
  country!: (typeof COUNTRIES)[number]

  // GSTIN (IN) or ABN (AU); the country-specific format check is in the
  // service - class-validator cannot see across fields.
  @IsString() @IsNotEmpty() @MaxLength(20)
  registrationNumber!: string

  @IsString() @IsNotEmpty() @MaxLength(200)
  legalEntityName!: string

  @IsString() @IsNotEmpty() @MaxLength(100)
  taxProfile!: string

  @IsOptional() @IsString() @MaxLength(20)
  fssaiLicense?: string

  @IsOptional() @IsBoolean()
  compositionScheme?: boolean
}

export class OutletDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string

  @IsString() @IsNotEmpty() @MaxLength(500)
  address!: string

  @IsIn(OUTLET_TYPES)
  type!: (typeof OUTLET_TYPES)[number]

  @IsString() @IsNotEmpty() @MaxLength(50)
  timezone!: string
}

export class BrandsOutletsDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  brandName!: string

  @IsDefined()
  @ValidateNested({ each: true })
  @Type(() => OutletDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  outlets!: OutletDto[]
}

export class SubscriptionDto {
  @IsIn(PLANS)
  plan!: (typeof PLANS)[number]

  @IsIn(BILLING_PERIODS)
  billingPeriod!: (typeof BILLING_PERIODS)[number]
}

export class OwnerInviteDto {
  @IsEmail()
  email!: string

  @IsString() @IsNotEmpty() @MaxLength(100)
  firstName!: string

  @IsString() @IsNotEmpty() @MaxLength(100)
  lastName!: string
}

export class SubmitTenantDto {
  @IsDefined()
  @ValidateNested() @Type(() => BusinessDetailsDto)
  business!: BusinessDetailsDto

  @IsDefined()
  @ValidateNested() @Type(() => TaxComplianceDto)
  tax!: TaxComplianceDto

  @IsDefined()
  @ValidateNested() @Type(() => BrandsOutletsDto)
  brandsOutlets!: BrandsOutletsDto

  @IsDefined()
  @ValidateNested() @Type(() => SubscriptionDto)
  subscription!: SubscriptionDto

  @IsDefined()
  @ValidateNested() @Type(() => OwnerInviteDto)
  ownerInvite!: OwnerInviteDto

  // AD-6 audit reason. The wizard does not collect one, so it defaults.
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500)
  reason?: string
}
