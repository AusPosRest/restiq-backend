// CAP-5 subscription mutation payloads. Suspend/reactivate always carry a
// required reason (AD-6) - a reasonless mutation never reaches the service.
import { Type } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator'

export class SuspendDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class ReactivateDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

// #290 billing contract line. Amounts are minor units per billing period of the tenant.
export class ContractItemDto {
  @IsString() @Matches(/\S/, { message: 'description must not be blank' }) @MaxLength(120)
  description!: string

  @IsInt() @Min(1) @Max(1000)
  quantity!: number

  @IsInt() @Min(0) @Max(100_000_000)
  unitAmountMinor!: number

  @IsIn(['recurring', 'one_time'])
  kind!: 'recurring' | 'one_time'
}

export class SaveContractDto {
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ContractItemDto)
  items!: ContractItemDto[]

  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}
