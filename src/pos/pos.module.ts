import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { PosAuthController } from './auth/auth.controller'
import { PosAuthService } from './auth/auth.service'
import { PosClockController } from './clock/clock.controller'
import { ClockService } from './clock/clock.service'

@Module({
  imports: [PlatformModule],
  controllers: [PosAuthController, PosClockController],
  providers: [PosAuthService, ClockService],
})
export class PosModule {}
