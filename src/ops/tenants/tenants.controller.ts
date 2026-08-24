import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { SubmitTenantDto } from './submit.dto'
import { DraftView, OpsTenantsService, ProvisionResult, TenantListItem } from './tenants.service'

@Controller('ops/v1/tenants')
export class OpsTenantsController {
  constructor(private readonly tenants: OpsTenantsService) {}

  @Get()
  async list(): Promise<{ tenants: TenantListItem[] }> {
    return { tenants: await this.tenants.list() }
  }

  @Get('draft')
  async getDraft(@CurrentOperator() operator: OpsPrincipal): Promise<{ draft: DraftView }> {
    return { draft: await this.tenants.getDraft(operator.id) }
  }

  @Put('draft/steps/:step')
  saveDraftStep(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('step', ParseIntPipe) step: number,
    @Body() body: Record<string, unknown>,
  ): Promise<{ updatedAt: string }> {
    return this.tenants.saveDraftStep(operator.id, step, body)
  }

  @Delete('draft')
  @HttpCode(204)
  async deleteDraft(@CurrentOperator() operator: OpsPrincipal): Promise<void> {
    await this.tenants.deleteDraft(operator.id)
  }

  @Post()
  @HttpCode(201)
  submit(@CurrentOperator() operator: OpsPrincipal, @Body() dto: SubmitTenantDto): Promise<ProvisionResult> {
    return this.tenants.provision(operator, dto)
  }
}
