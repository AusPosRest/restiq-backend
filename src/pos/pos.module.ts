import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { PosAttendanceController } from './clock/attendance.controller'
import { AttendanceService } from './clock/attendance.service'
import { PosAuthController } from './auth/auth.controller'
import { PosAuthService } from './auth/auth.service'
import { PosBillsController } from './bills/bills.controller'
import { BillsService } from './bills/bills.service'
import { PosClockController } from './clock/clock.controller'
import { ClockService } from './clock/clock.service'
import { OrderLinesService } from './orders/order-lines.service'
import { PosOrdersController } from './orders/orders.controller'
import { OrdersService } from './orders/orders.service'
import { PosShiftsController } from './shifts/shifts.controller'
import { ShiftsService } from './shifts/shifts.service'

@Module({
  imports: [PlatformModule],
  controllers: [PosAuthController, PosClockController, PosAttendanceController, PosOrdersController, PosShiftsController, PosBillsController],
  providers: [PosAuthService, ClockService, AttendanceService, OrdersService, OrderLinesService, ShiftsService, BillsService],
})
export class PosModule {}
