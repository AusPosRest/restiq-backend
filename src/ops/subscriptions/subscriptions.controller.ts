import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { ReactivateDto, SuspendDto } from './subscriptions.dtos'
import { InvoiceView, SubscriptionsService, SubscriptionView } from './subscriptions.service'

// Tenant-scoped only (Tenant Detail's Subscription tab): same read/mutation
// pattern as devices, nested under the owning tenant per the URL convention.
@Controller('ops/v1/tenants/:tenantId/subscription')
export class OpsSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  get(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<SubscriptionView> {
    return this.subscriptions.get(tenantId)
  }

  @Get('invoices')
  listInvoices(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<{ invoices: InvoiceView[] }> {
    return this.subscriptions.listInvoices(tenantId)
  }

  @Post('suspend')
  @HttpCode(200)
  suspend(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SuspendDto,
  ): Promise<{ subscription: SubscriptionView }> {
    return this.subscriptions.suspend(operator, tenantId, dto.reason)
  }

  @Post('reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: ReactivateDto,
  ): Promise<{ subscription: SubscriptionView }> {
    return this.subscriptions.reactivate(operator, tenantId, dto.reason)
  }
}
