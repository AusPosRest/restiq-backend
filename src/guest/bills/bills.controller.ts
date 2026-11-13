import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import type { InvoiceView } from '../../pos/bills'
import { CurrentGuest, GuestPrincipal } from '../../platform'
import { CardPaymentStartView, GuestBillView, SimulatedPaymentDto, StartCardPaymentDto } from './bills.dtos'
import { GuestBillsService } from './bills.service'
import { GuestCardPaymentsService } from './card-payments.service'

@Controller('guest/v1')
export class GuestBillsController {
  constructor(
    private readonly bills: GuestBillsService,
    private readonly cards: GuestCardPaymentsService,
  ) {}

  // Issue #98: 201 for a genuinely new Bill, 200 when one already existed
  // for this order (idempotent - see GuestBillsService.createBill).
  @Post('orders/:orderId/bill')
  async createBill(@CurrentGuest() guest: GuestPrincipal, @Param('orderId') orderId: string, @Res({ passthrough: true }) res: Response): Promise<GuestBillView> {
    const { view, created } = await this.bills.createBill(guest, orderId)
    res.status(created ? 201 : 200)
    return view
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

  // #284: real card payments (Stripe) - see card-payments.service.ts.
  @Post('bills/:id/card-payment')
  @HttpCode(200)
  startCardPayment(@CurrentGuest() guest: GuestPrincipal, @Param('id') billId: string, @Body() dto: StartCardPaymentDto): Promise<CardPaymentStartView> {
    return this.cards.start(guest, billId, dto)
  }

  @Post('card-payments/:intentId/sync')
  @HttpCode(200)
  syncCardPayment(@CurrentGuest() guest: GuestPrincipal, @Param('intentId') intentId: string): Promise<GuestBillView> {
    return this.cards.sync(guest, intentId)
  }

  @Get('bills/:id/invoice')
  getInvoice(@CurrentGuest() guest: GuestPrincipal, @Param('id') billId: string): Promise<InvoiceView> {
    return this.bills.getInvoice(guest, billId)
  }
}
