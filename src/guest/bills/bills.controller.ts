import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { CurrentGuest, GuestPrincipal } from '../../platform'
import { GuestBillView, SimulatedPaymentDto } from './bills.dtos'
import { GuestBillsService } from './bills.service'

@Controller('guest/v1')
export class GuestBillsController {
  constructor(private readonly bills: GuestBillsService) {}

  @Post('orders/:orderId/bill')
  @HttpCode(201)
  createBill(@CurrentGuest() guest: GuestPrincipal, @Param('orderId') orderId: string): Promise<GuestBillView> {
    return this.bills.createBill(guest, orderId)
  }

  @Get('orders/:orderId/bill')
  getBill(@CurrentGuest() guest: GuestPrincipal, @Param('orderId') orderId: string): Promise<GuestBillView> {
    return this.bills.getBill(guest, orderId)
  }

  @Post('bills/:id/shares/:guestId/pay')
  @HttpCode(200)
  payShare(
    @CurrentGuest() guest: GuestPrincipal,
    @Param('id') billId: string,
    @Param('guestId') guestId: string,
    @Body() dto: SimulatedPaymentDto,
  ): Promise<GuestBillView> {
    return this.bills.payShare(guest, billId, guestId, dto)
  }

  @Post('bills/:id/pay-all')
  @HttpCode(200)
  payAll(@CurrentGuest() guest: GuestPrincipal, @Param('id') billId: string, @Body() dto: SimulatedPaymentDto): Promise<GuestBillView> {
    return this.bills.payAll(guest, billId, dto)
  }
}
