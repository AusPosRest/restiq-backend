import { IsHexColor, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

// PUT merges the given fields into the tenant's stored branding_tokens JSON
// (Tenant.brandingTokens) - fields the caller omits keep their current
// value, so the settings form can save one edited field without resending
// the whole token set.
export class UpdateBrandingDto {
  @IsOptional() @IsHexColor()
  primaryColor?: string

  @IsOptional() @IsHexColor()
  secondaryColor?: string

  @IsOptional() @IsHexColor()
  accentColor?: string

  @IsOptional() @IsHexColor()
  surfaceColor?: string

  @IsOptional() @IsString() @MaxLength(100)
  font?: string

  @IsOptional() @IsInt() @Min(0) @Max(64)
  cornerRadiusPx?: number

  @IsOptional() @IsString() @MaxLength(2048)
  logoUrl?: string

  @IsOptional() @IsString() @MaxLength(200)
  receiptHeader?: string

  @IsOptional() @IsString() @MaxLength(200)
  receiptFooter?: string
}

export interface BrandingView {
  primaryColor: string | null
  secondaryColor: string | null
  accentColor: string | null
  surfaceColor: string | null
  font: string | null
  cornerRadiusPx: number | null
  logoUrl: string | null
  receiptHeader: string | null
  receiptFooter: string | null
}
