import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { CartController } from './cart/cart.controller'
import { CartService } from './cart/cart.service'
import { GuestMenuController } from './menu/menu.controller'
import { GuestMenuService } from './menu/menu.service'
import { GuestSessionsController } from './sessions/sessions.controller'
import { GuestSessionsService } from './sessions/sessions.service'

@Module({
  imports: [PlatformModule],
  controllers: [GuestSessionsController, GuestMenuController, CartController],
  providers: [GuestSessionsService, GuestMenuService, CartService],
  // GuestSessionsService is consumed by pos/tables/tables.controller.ts for
  // the staff-side close (AD-2: cross-module reach only via this barrel).
  exports: [GuestSessionsService],
})
export class GuestModule {}
