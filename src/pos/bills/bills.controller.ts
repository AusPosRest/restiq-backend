import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { BillsService } from './bills.service'
import { BillView, CreditNoteView, FinalizeBillDto, RefundBillDto } from './bills.dtos'

@Controller('pos/v1')
export class PosBillsController {
  constructor(private readonly bills: BillsService) {}

  // Issue #98: 201 for a genuinely new Bill, 200 when one already existed
  // for this order (idempotent - see BillsService.createBill) - the status
  // code depends on a runtime flag, so it's set here rather than via a
  // static @HttpCode.
  @Post('orders/:orderId/bill')
  async create(@CurrentStaff() staff: PosPrincipal, @Param('orderId') orderId: string, @Res({ passthrough: true }) res: Response): Promise<BillView> {
    const { view, created } = await this.bills.createBill(staff, orderId)
    res.status(created ? 201 : 200)
    return view
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

  @Post('bills/:id/refund')
  @HttpCode(201)
  refund(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string, @Body() dto: RefundBillDto): Promise<CreditNoteView> {
    return this.bills.refund(staff, id, dto)
  }
}
