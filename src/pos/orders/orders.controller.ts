import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { OrderView, TableMapEntry, TransferOrderDto, UpdateOrderStatusDto } from './orders.dtos'
import { OrdersService } from './orders.service'

@Controller('pos/v1')
export class PosOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('outlets/:outletId/table-map')
  getTableMap(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<TableMapEntry[]> {
    return this.orders.getTableMap(staff, outletId)
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
}
