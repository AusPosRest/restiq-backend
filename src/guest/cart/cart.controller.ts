import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { CurrentGuest, GuestPrincipal } from '../../platform'
import { AddCartLineDto, TableCartView, UpdateCartLineDto } from './cart.dtos'
import { CartService } from './cart.service'

@Controller('guest/v1/cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  getCart(@CurrentGuest() guest: GuestPrincipal): Promise<TableCartView> {
    return this.cart.getCart(guest)
  }

  @Post('lines')
  addLine(@CurrentGuest() guest: GuestPrincipal, @Body() dto: AddCartLineDto): Promise<TableCartView> {
    return this.cart.addLine(guest, dto)
  }

  @Patch('lines/:id')
  updateLine(@CurrentGuest() guest: GuestPrincipal, @Param('id') id: string, @Body() dto: UpdateCartLineDto): Promise<TableCartView> {
    return this.cart.updateLine(guest, id, dto)
  }

  @Delete('lines/:id')
  removeLine(@CurrentGuest() guest: GuestPrincipal, @Param('id') id: string): Promise<TableCartView> {
    return this.cart.removeLine(guest, id)
  }
}
