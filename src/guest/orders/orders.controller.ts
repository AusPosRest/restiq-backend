import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { CurrentGuest, GuestPrincipal } from '../../platform'
import { GuestOrderStatusView, GuestSessionOrdersView, PlacedOrderView } from './orders.dtos'
import { GuestOrdersService } from './orders.service'

// Controller-level path is 'guest/v1' rather than 'guest/v1/orders' (unlike
// most of this module's controllers) because CAP-6 (issue #81) adds a route
// under 'session/', not 'orders/' - see GuestSessionsController's own
// 'guest/v1' + 'session' route for the sibling read this pairs with.
@Controller('guest/v1')
export class GuestOrdersController {
  constructor(private readonly orders: GuestOrdersService) {}

  @Post('orders')
  @HttpCode(201)
  placeOrder(@CurrentGuest() guest: GuestPrincipal): Promise<PlacedOrderView> {
    return this.orders.placeOrder(guest)
  }

  @Get('orders/:orderId/status')
  getOrderStatus(@CurrentGuest() guest: GuestPrincipal, @Param('orderId') orderId: string): Promise<GuestOrderStatusView> {
    return this.orders.getOrderStatus(guest, orderId)
  }

  @Get('session/orders')
  listSessionOrders(@CurrentGuest() guest: GuestPrincipal): Promise<GuestSessionOrdersView> {
    return this.orders.listSessionOrders(guest)
  }
}
