import { Transform, TransformFnParams } from 'class-transformer'
import { IsBoolean, IsOptional, IsString, Length, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator'
import type { OutletType } from '../../generated/prisma/client'

export interface OutletView {
  id: string
  name: string
  address: string
  type: OutletType
  timezone: string
}

export interface CapabilityView {
  key: string
  enabled: boolean
}

export class SetCapabilityDto {
  @IsBoolean()
  enabled!: boolean
}

const trim = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value)

@ValidatorConstraint({ name: 'isIanaTimezone', async: false })
class IsIanaTimezoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }

  defaultMessage(): string {
    return 'timezone must be a valid IANA zone'
  }
}

export class UpdateOutletDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 120)
  name?: string

  @IsOptional() @Transform(trim) @IsString() @Length(1, 500)
  address?: string

  @IsOptional() @Transform(trim) @IsString() @Validate(IsIanaTimezoneConstraint)
  timezone?: string
}
