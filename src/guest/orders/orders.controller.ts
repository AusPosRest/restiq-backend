import { Controller, HttpCode, Post } from '@nestjs/common'
import { CurrentGuest, GuestPrincipal } from '../../platform'
import { PlacedOrderView } from './orders.dtos'
import { GuestOrdersService } from './orders.service'

@Controller('guest/v1/orders')
export class GuestOrdersController {
  constructor(private readonly orders: GuestOrdersService) {}

  @Post()
  @HttpCode(201)
  placeOrder(@CurrentGuest() guest: GuestPrincipal): Promise<PlacedOrderView> {
    return this.orders.placeOrder(guest)
  }
}
