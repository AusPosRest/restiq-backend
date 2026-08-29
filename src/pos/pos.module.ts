import { Module } from '@nestjs/common'
import { GuestModule } from '../guest'
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
import { PosTablesController } from './tables/tables.controller'

@Module({
  imports: [PlatformModule, GuestModule],
  controllers: [
    PosAuthController,
    PosClockController,
    PosAttendanceController,
    PosOrdersController,
    PosShiftsController,
    PosBillsController,
    PosTablesController,
  ],
  providers: [PosAuthService, ClockService, AttendanceService, OrdersService, OrderLinesService, ShiftsService, BillsService],
})
export class PosModule {}
