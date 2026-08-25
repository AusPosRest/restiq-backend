import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { BillsService } from './bills.service'
import { BillView, FinalizeBillDto } from './bills.dtos'

@Controller('pos/v1')
export class PosBillsController {
  constructor(private readonly bills: BillsService) {}

  @Post('orders/:orderId/bill')
  @HttpCode(201)
  create(@CurrentStaff() staff: PosPrincipal, @Param('orderId') orderId: string): Promise<BillView> {
    return this.bills.createBill(staff, orderId)
  }

  @Get('bills/:id')
  getOne(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string): Promise<BillView> {
    return this.bills.getBill(staff, id)
  }

  @Post('bills/:id/finalize')
  @HttpCode(200)
  finalize(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string, @Body() dto: FinalizeBillDto): Promise<BillView> {
    return this.bills.finalize(staff, id, dto)
  }
}
