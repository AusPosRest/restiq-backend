// CAP-5 subscription mutation payloads. Suspend/reactivate always carry a
// required reason (AD-6) - a reasonless mutation never reaches the service.
import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class SuspendDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}

export class ReactivateDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string
}
