import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { DeviceSourceDto } from '../devices/devices.dtos'
import { BillsService } from './bills.service'
import { BillView, CreditNoteView, FinalizeBillDto, InvoiceView, PrintJobView, RefundBillDto } from './bills.dtos'

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

  // issue #125: 200s with a pro-forma view before finalize too (bill-core.ts's buildInvoiceView) - same auth/ownership as getOne above (owner-unrestricted, unlike create).
  @Get('bills/:id/invoice')
  getInvoice(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string): Promise<InvoiceView> {
    return this.bills.getInvoice(staff, id)
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

  // Simulated printer spool (issue #127). Same owner-unrestricted auth as
  // getInvoice - any staff member at the outlet can send a bill to print.
  @Post('bills/:id/print')
  @HttpCode(201)
  print(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string, @Body() dto?: DeviceSourceDto): Promise<PrintJobView> {
    // No body at all (older clients) arrives as undefined, not {}.
    return this.bills.printBill(staff, id, dto?.deviceId)
  }

  // ?deviceId= is the polling printer (issue #134): a linked printer drains only its own queue.
  @Get('outlets/:outletId/print-jobs')
  listPrintJobs(
    @CurrentStaff() staff: PosPrincipal,
    @Param('outletId') outletId: string,
    @Query('deviceId', new ParseUUIDPipe({ optional: true })) deviceId?: string,
  ): Promise<PrintJobView[]> {
    return this.bills.listPendingPrintJobs(staff, outletId, deviceId)
  }

  @Post('print-jobs/:id/printed')
  @HttpCode(200)
  markPrinted(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string): Promise<PrintJobView> {
    return this.bills.markPrinted(staff, id)
  }
}
