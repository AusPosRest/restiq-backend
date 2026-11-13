import { Body, Controller, Get, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { CardReaderView, CreateReaderOrderDto, ReaderOrderView, ReaderOrdersService, ReaderPriceView } from '../../ops'

// #286: the owner's Card readers page - their readers, what they can order, and their orders.
// The tenant is always the signed-in owner's own (never from the request).
@Controller('admin/v1')
export class AdminCardReadersController {
  constructor(private readonly orders: ReaderOrdersService) {}

  @Get('card-readers')
  overview(@CurrentOwner() owner: AdminPrincipal): Promise<{ readers: CardReaderView[]; prices: ReaderPriceView[]; cardOnFile: boolean; orders: ReaderOrderView[] }> {
    return this.orders.ownerOverview(owner)
  }

  @Post('reader-orders')
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: CreateReaderOrderDto): Promise<{ order: ReaderOrderView }> {
    return this.orders.create(owner, dto)
  }
}
