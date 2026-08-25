import { Controller, HttpCode, Post } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { ClockEventView } from '../auth/auth.dtos'
import { ClockService } from './clock.service'

@Controller('pos/v1/clock')
export class PosClockController {
  constructor(private readonly clock: ClockService) {}

  @Post('out')
  @HttpCode(200)
  clockOut(@CurrentStaff() staff: PosPrincipal): Promise<ClockEventView> {
    return this.clock.clockOut(staff)
  }
}
