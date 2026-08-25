import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { AddOrderLineDto, OrderView, TableMapEntry, TransferOrderDto, UpdateOrderLineDto, UpdateOrderStatusDto } from './orders.dtos'
import { OrderLinesService } from './order-lines.service'
import { OrdersService } from './orders.service'

@Controller('pos/v1')
export class PosOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly orderLines: OrderLinesService,
  ) {}

  @Get('outlets/:outletId/table-map')
  getTableMap(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<TableMapEntry[]> {
    return this.orders.getTableMap(staff, outletId)
  }

  // pos/CAP-5: outlet-wide, unlike table-map above which only shows orders
  // tied to a table - a counter order (tableId null) would be invisible on
  // the table map but must still show up here.
  @Get('outlets/:outletId/orders')
  listOpenOrders(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<OrderView[]> {
    return this.orders.listOpenOrders(staff, outletId)
  }

  // 200 always, not 201-on-create/200-on-existing: this is a get-or-open
  // action from the caller's point of view (occupied tables return the
  // existing order unchanged, never an error) - one status code, not a
  // conditional one the client has to branch on.
  @Post('outlets/:outletId/tables/:tableId/order')
  @HttpCode(200)
  openOrClaimTable(
    @CurrentStaff() staff: PosPrincipal,
    @Param('outletId') outletId: string,
    @Param('tableId') tableId: string,
  ): Promise<OrderView> {
    return this.orders.openOrClaimTable(staff, outletId, tableId)
  }

  // pos/CAP-6 QSR counter and token mode (issue #62): a counter order has no
  // table to key a get-or-open lookup on (unlike openOrClaimTable above), so
  // unlike that 200-always endpoint, this always creates a brand-new order
  // and token - 201, not 200.
  @Post('outlets/:outletId/counter-orders')
  @HttpCode(201)
  createCounterOrder(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<OrderView> {
    return this.orders.createCounterOrder(staff, outletId)
  }

  @Get('orders/:orderId')
  getOrder(@CurrentStaff() staff: PosPrincipal, @Param('orderId') orderId: string): Promise<OrderView> {
    return this.orders.getOrder(staff, orderId)
  }

  @Patch('orders/:orderId/status')
  updateStatus(
    @CurrentStaff() staff: PosPrincipal,
    @Param('orderId') orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ): Promise<OrderView> {
    return this.orders.updateStatus(staff, orderId, dto)
  }

  @Post('orders/:orderId/transfer')
  transfer(@CurrentStaff() staff: PosPrincipal, @Param('orderId') orderId: string, @Body() dto: TransferOrderDto): Promise<OrderView> {
    return this.orders.transfer(staff, orderId, dto)
  }

  @Post('orders/:orderId/lines')
  @HttpCode(201)
  addLine(@CurrentStaff() staff: PosPrincipal, @Param('orderId') orderId: string, @Body() dto: AddOrderLineDto): Promise<OrderView> {
    return this.orderLines.addLine(staff, orderId, dto)
  }

  @Patch('orders/:orderId/lines/:lineId')
  updateLine(
    @CurrentStaff() staff: PosPrincipal,
    @Param('orderId') orderId: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateOrderLineDto,
  ): Promise<OrderView> {
    return this.orderLines.updateLine(staff, orderId, lineId, dto)
  }

  @Delete('orders/:orderId/lines/:lineId')
  removeLine(@CurrentStaff() staff: PosPrincipal, @Param('orderId') orderId: string, @Param('lineId') lineId: string): Promise<OrderView> {
    return this.orderLines.removeLine(staff, orderId, lineId)
  }
}
