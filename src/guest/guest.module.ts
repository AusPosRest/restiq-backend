import { Module } from '@nestjs/common'
import { KitchenModule } from '../kitchen'
import { PlatformModule } from '../platform'
import { GuestBillsController } from './bills/bills.controller'
import { GuestBillsService } from './bills/bills.service'
import { GuestCardPaymentsService } from './bills/card-payments.service'
import { StripeConnectWebhookController } from './bills/stripe-connect-webhook.controller'
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
//
// qr-self-order/CAP-5 (issue #80): GuestBillsService does NOT import PosModule
// (that would cycle - PosModule already imports GuestModule for the
// staff-side session close below) - it reuses pos/bills' shared money-path
// core as plain functions through that module's scoped barrel
// (src/pos/bills/index.ts), not a NestJS provider.
@Module({
  imports: [PlatformModule, KitchenModule],
  controllers: [GuestSessionsController, GuestMenuController, CartController, GuestOrdersController, GuestBillsController, StripeConnectWebhookController],
  providers: [GuestSessionsService, GuestMenuService, CartService, GuestOrdersService, GuestBillsService, GuestCardPaymentsService],
  // GuestSessionsService is consumed by pos/tables/tables.controller.ts for
  // the staff-side close (AD-2: cross-module reach only via this barrel).
  // #286: GuestCardPaymentsService is pos/payments' Stripe settlement path too (POS card readers).
  exports: [GuestSessionsService, GuestCardPaymentsService],
})
export class GuestModule {}
