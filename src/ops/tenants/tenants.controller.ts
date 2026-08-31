import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { CapabilityKey, ReasonDto, ToggleCapabilityDto, UpdateBrandingDto, UpdateTenantDto } from './directory.dtos'
import { InviteView, TenantDetail, TenantDirectoryService, TenantListResult } from './directory.service'
import { SubmitTenantDto } from './submit.dto'
import { DraftView, OpsTenantsService, ProvisionResult } from './tenants.service'

@Controller('ops/v1/tenants')
export class OpsTenantsController {
  constructor(
    private readonly tenants: OpsTenantsService,
    private readonly directory: TenantDirectoryService,
  ) {}

  @Get()
  list(@Query() query: Record<string, string | undefined>): Promise<TenantListResult> {
    return this.directory.list(query)
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

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<TenantDetail> {
    return this.directory.detail(id)
  }

  @Patch(':id')
  updateBasics(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
  ): Promise<{ tenant: { id: string; name: string } }> {
    return this.directory.updateBasics(operator, id, dto)
  }

  @Put(':id/capabilities/:key')
  toggleCapability(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() dto: ToggleCapabilityDto,
  ): Promise<{ capability: { key: CapabilityKey; enabled: boolean } }> {
    return this.directory.toggleCapability(operator, id, key, dto)
  }

  @Put(':id/branding')
  updateBranding(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandingDto,
  ): Promise<{ brandingTokens: Record<string, string> }> {
    return this.directory.updateBranding(operator, id, dto)
  }

  @Post(':id/owner-invite/regenerate')
  @HttpCode(200)
  regenerateOwnerInvite(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<{ invite: InviteView }> {
    return this.directory.regenerateOwnerInvite(operator, id, dto.reason)
  }

  @Post(':id/activate')
  @HttpCode(200)
  activate(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<{ tenant: { id: string; status: string } }> {
    return this.directory.activate(operator, id, dto.reason)
  }
}
