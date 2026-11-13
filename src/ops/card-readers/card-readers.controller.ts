import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import {
  CardReaderView,
  ListReaderOrdersQuery,
  ReaderOrderView,
  ReaderPriceView,
  RegisterCardReaderDto,
  RemoveCardReaderDto,
  UpdateReaderOrderDto,
  UpdateReaderPriceDto,
} from './card-readers.dtos'
import { CardReadersService } from './card-readers.service'
import { ReaderOrdersService } from './reader-orders.service'

// #286: Platform Console - reader prices, a tenant's readers, and reader orders across tenants.
@Controller('ops/v1')
export class OpsCardReadersController {
  constructor(
    private readonly readers: CardReadersService,
    private readonly orders: ReaderOrdersService,
  ) {}

  @Get('reader-prices')
  listPrices(): Promise<{ prices: ReaderPriceView[] }> {
    return this.readers.listPrices()
  }

  @Put('reader-prices/:country/:model')
  updatePrice(@CurrentOperator() operator: OpsPrincipal, @Param('country') country: string, @Param('model') model: string, @Body() dto: UpdateReaderPriceDto): Promise<{ price: ReaderPriceView }> {
    return this.readers.updatePrice(operator, country, model, dto)
  }

  @Get('tenants/:tenantId/card-readers')
  listReaders(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<{ readers: CardReaderView[] }> {
    return this.readers.listForTenant(tenantId)
  }

  @Post('tenants/:tenantId/card-readers')
  register(@CurrentOperator() operator: OpsPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() dto: RegisterCardReaderDto): Promise<{ reader: CardReaderView }> {
    return this.readers.register(operator, tenantId, dto)
  }

  @Delete('tenants/:tenantId/card-readers/:readerId')
  @HttpCode(204)
  remove(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('readerId', ParseUUIDPipe) readerId: string,
    @Body() dto: RemoveCardReaderDto,
  ): Promise<void> {
    return this.readers.remove(operator, tenantId, readerId, dto.reason)
  }

  @Get('reader-orders')
  listOrders(@Query() query: ListReaderOrdersQuery): Promise<{ orders: ReaderOrderView[] }> {
    return this.orders.listAll(query.status)
  }

  @Get('tenants/:tenantId/reader-orders')
  listTenantOrders(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<{ orders: ReaderOrderView[] }> {
    return this.orders.listForTenant(tenantId)
  }

  @Patch('reader-orders/:orderId')
  updateOrder(@CurrentOperator() operator: OpsPrincipal, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: UpdateReaderOrderDto): Promise<{ order: ReaderOrderView }> {
    return this.orders.update(operator, orderId, dto)
  }
}
