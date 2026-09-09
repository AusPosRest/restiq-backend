import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { CreatePaymentIntentDto, PaymentIntentView, SimulateIntentDto } from './intents.dtos'
import { PaymentIntentsService } from './intents.service'

// Payments, first slice (issue #130): the simulated card terminal's routes.
// Same pos realm and guard as bills - the terminal device signs in at the
// PIN pad like the printer does.
@Controller('pos/v1')
export class PosPaymentIntentsController {
  constructor(private readonly intents: PaymentIntentsService) {}

  // 201 for a new intent, 200 for a repeat of the same clientKey - runtime
  // flag, so set here rather than via a static @HttpCode (same as bills'
  // create).
  @Post('bills/:id/intents')
  async create(
    @CurrentStaff() staff: PosPrincipal,
    @Param('id') billId: string,
    @Body() dto: CreatePaymentIntentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentIntentView> {
    const { view, created } = await this.intents.createIntent(staff, billId, dto)
    res.status(created ? 201 : 200)
    return view
  }

  @Get('payment-intents/:id')
  getOne(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string): Promise<PaymentIntentView> {
    return this.intents.getIntent(staff, id)
  }

  @Post('payment-intents/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string): Promise<PaymentIntentView> {
    return this.intents.cancelIntent(staff, id)
  }

  @Post('payment-intents/:id/simulate')
  @HttpCode(200)
  simulate(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string, @Body() dto: SimulateIntentDto): Promise<PaymentIntentView> {
    return this.intents.simulate(staff, id, dto)
  }

  @Get('outlets/:outletId/payment-intents')
  listPending(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<PaymentIntentView[]> {
    return this.intents.listPendingForOutlet(staff, outletId)
  }
}
