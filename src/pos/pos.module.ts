import { Module } from '@nestjs/common'
import { GuestModule } from '../guest'
import { KitchenModule } from '../kitchen'
import { PlatformModule } from '../platform'
import { PosAttendanceController } from './clock/attendance.controller'
import { AttendanceService } from './clock/attendance.service'
import { PosAuthController } from './auth/auth.controller'
import { PosAuthService } from './auth/auth.service'
import { PosBillsController } from './bills/bills.controller'
import { BillsService } from './bills/bills.service'
import { PosClockController } from './clock/clock.controller'
import { ClockService } from './clock/clock.service'
import { PosDevicesController } from './devices/devices.controller'
import { PosDevicesService } from './devices/devices.service'
import { PosMenuController } from './menu/menu.controller'
import { MenuService } from './menu/menu.service'
import { OrderLinesService } from './orders/order-lines.service'
import { PosOrdersController } from './orders/orders.controller'
import { OrdersService } from './orders/orders.service'
import { PosPaymentIntentsController } from './payments/intents.controller'
import { PaymentIntentsService } from './payments/intents.service'
import { PosShiftsController } from './shifts/shifts.controller'
import { ShiftsService } from './shifts/shifts.service'
import { PosTablesController } from './tables/tables.controller'
// Offline sync (restiq-backend#185) lives here because every pushed op is a
// pos order/bill operation - it calls these same services.
import { SyncController } from './sync/sync.controller'
import { SyncPushService } from './sync/sync-push.service'
import { SyncService } from './sync/sync.service'

@Module({
  imports: [PlatformModule, GuestModule, KitchenModule],
  controllers: [
    PosAuthController,
    PosClockController,
    PosAttendanceController,
    PosMenuController,
    PosOrdersController,
    PosShiftsController,
    PosBillsController,
    PosPaymentIntentsController,
    PosTablesController,
    PosDevicesController,
    SyncController,
  ],
  providers: [
    PosAuthService,
    ClockService,
    MenuService,
    AttendanceService,
    OrdersService,
    OrderLinesService,
    ShiftsService,
    BillsService,
    PaymentIntentsService,
    PosDevicesService,
    SyncService,
    SyncPushService,
  ],
})
export class PosModule {}
