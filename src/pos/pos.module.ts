import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { PosAuthController } from './auth/auth.controller'
import { PosAuthService } from './auth/auth.service'
import { PosClockController } from './clock/clock.controller'
import { ClockService } from './clock/clock.service'
import { PosOrdersController } from './orders/orders.controller'
import { OrdersService } from './orders/orders.service'
import { PosShiftsController } from './shifts/shifts.controller'
import { ShiftsService } from './shifts/shifts.service'

@Module({
  imports: [PlatformModule],
  controllers: [PosAuthController, PosClockController, PosOrdersController, PosShiftsController],
  providers: [PosAuthService, ClockService, OrdersService, ShiftsService],
})
export class PosModule {}
