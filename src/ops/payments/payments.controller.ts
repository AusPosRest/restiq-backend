import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { UpdatePaymentsDto } from './payments.dtos'
import { PaymentsService, PaymentsView } from './payments.service'

// #282: Tenant Detail's Payments tab - the restaurant's Stripe Connect account.
@Controller('ops/v1/tenants/:tenantId/payments')
export class OpsPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  get(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<{ payments: PaymentsView }> {
    return this.payments.get(tenantId)
  }

  @Post('onboarding-link')
  @HttpCode(200)
  onboardingLink(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<{ url: string; expiresAt: string; payments: PaymentsView }> {
    return this.payments.onboardingLink(tenantId)
  }

  @Patch()
  update(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: UpdatePaymentsDto,
  ): Promise<{ payments: PaymentsView }> {
    return this.payments.update(operator, tenantId, dto)
  }
}
