import { Body, Controller, Get, Param, Put } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { PlanPriceView, UpdatePlanPriceDto } from './plan-prices.dtos'
import { PlanPricesService } from './plan-prices.service'

@Controller('ops/v1/plan-prices')
export class OpsPlanPricesController {
  constructor(private readonly prices: PlanPricesService) {}

  @Get()
  list(): Promise<{ prices: PlanPriceView[] }> {
    return this.prices.list()
  }

  @Put(':country/:plan')
  update(@CurrentOperator() operator: OpsPrincipal, @Param('country') country: string, @Param('plan') plan: string, @Body() dto: UpdatePlanPriceDto): Promise<{ price: PlanPriceView }> {
    return this.prices.update(operator, country, plan, dto)
  }
}
