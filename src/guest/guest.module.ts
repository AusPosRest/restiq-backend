import { Module } from '@nestjs/common'
import { KitchenModule } from '../kitchen'
import { PlatformModule } from '../platform'
import { CartController } from './cart/cart.controller'
import { CartService } from './cart/cart.service'
import { GuestMenuController } from './menu/menu.controller'
import { GuestMenuService } from './menu/menu.service'
import { GuestOrdersController } from './orders/orders.controller'
import { GuestOrdersService } from './orders/orders.service'
import { GuestSessionsController } from './sessions/sessions.controller'
import { GuestSessionsService } from './sessions/sessions.service'

// qr-self-order/CAP-4 (issue #77): imports KitchenModule so
// GuestOrdersService can fire tickets through the real KitchenTicketsService
// (AD-16) - no cycle, since KitchenModule itself only imports PlatformModule.
@Module({
  imports: [PlatformModule, KitchenModule],
  controllers: [GuestSessionsController, GuestMenuController, CartController, GuestOrdersController],
  providers: [GuestSessionsService, GuestMenuService, CartService, GuestOrdersService],
  // GuestSessionsService is consumed by pos/tables/tables.controller.ts for
  // the staff-side close (AD-2: cross-module reach only via this barrel).
  exports: [GuestSessionsService],
})
export class GuestModule {}
