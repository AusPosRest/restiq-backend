// Hub mode (#293): the POS and kitchen controllers and services, without
// PosModule's imports of OpsModule and GuestModule - so no ops, admin, sync
// or webhook controllers and no SyncHealthService sweep timer exist on the
// hub. The four guest/ops services below are here only because POS
// services take them by injection.
// Loaded first, as in the cloud app: pos and guest import each other, and
// loading guest first leaves PaymentIntentsService's injected guest class undefined.
import '../pos'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { GuestBillsService } from '../guest/bills/bills.service'
import { GuestCardPaymentsService, GuestSessionsService } from '../guest'
import { HealthController } from '../health.controller'
import { KitchenModule } from '../kitchen'
import { CardReadersService } from '../ops'
import { PlatformModule } from '../platform'
import { PosAuthController } from '../pos/auth/auth.controller'
import { PosAuthService } from '../pos/auth/auth.service'
import { PosBillsController } from '../pos/bills/bills.controller'
import { BillsService } from '../pos/bills/bills.service'
import { PosAttendanceController } from '../pos/clock/attendance.controller'
import { AttendanceService } from '../pos/clock/attendance.service'
import { PosClockController } from '../pos/clock/clock.controller'
import { ClockService } from '../pos/clock/clock.service'
import { PosDevicesController } from '../pos/devices/devices.controller'
import { PosDevicesService } from '../pos/devices/devices.service'
import { PosMenuController } from '../pos/menu/menu.controller'
import { MenuService } from '../pos/menu/menu.service'
import { OrderLinesService } from '../pos/orders/order-lines.service'
import { PosOrdersController } from '../pos/orders/orders.controller'
import { OrdersService } from '../pos/orders/orders.service'
import { PosPaymentIntentsController } from '../pos/payments/intents.controller'
import { PaymentIntentsService } from '../pos/payments/intents.service'
import { PosShiftsController } from '../pos/shifts/shifts.controller'
import { ShiftsService } from '../pos/shifts/shifts.service'
import { PosTablesController } from '../pos/tables/tables.controller'
import { PosTenantController } from '../pos/tenant.controller'
import { hubAllowlist } from './allowlist'
import { HubStatusController } from './hub-status.controller'
import { HubContext, HubLockGuard } from './lock.guard'
import { OpRecorderInterceptor } from './op-recorder.interceptor'
import type { PGlite } from '@electric-sql/pglite'

@Module({
  imports: [PlatformModule, KitchenModule],
  controllers: [
    HealthController,
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
    PosTenantController,
    HubStatusController,
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
    GuestSessionsService,
    GuestBillsService,
    GuestCardPaymentsService,
    CardReadersService,
  ],
})
export class HubModule {}

/**
 * The hub's Nest app, not yet listening, recording every write as an op in pg's outbox and dataDir's journal, calling onOp after each.
 * hub supplies the clock and the sync worker to the status endpoints and the O1 lock (H6). The caller must have called setPrismaClient() first.
 */
export async function createHubApp(pg: PGlite, dataDir: string, onOp?: () => void, hub = new HubContext(pg)): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>({ module: HubModule, providers: [{ provide: HubContext, useValue: hub }] }, { logger: ['error', 'warn'] })
  app.use(hubAllowlist)
  // After the APP_GUARDs (added at create), so PosAuthGuard has already answered 401/403.
  app.useGlobalGuards(new HubLockGuard(hub))
  app.useGlobalInterceptors(new OpRecorderInterceptor(pg, dataDir, onOp))
  return app
}
