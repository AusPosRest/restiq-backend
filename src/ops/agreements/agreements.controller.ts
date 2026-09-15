import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, StreamableFile } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { AgreementVersionSummary, AgreementVersionView, PublishAgreementDto, TenantAgreementsView } from './agreements.dtos'
import { AgreementsService } from './agreements.service'

// Platform-wide versions under ops/v1/agreements; a tenant's standing and its
// signed PDFs nested under the owning tenant per the URL convention (same as
// subscription).
@Controller('ops/v1')
export class OpsAgreementsController {
  constructor(private readonly agreements: AgreementsService) {}

  @Get('agreements')
  list(): Promise<{ versions: AgreementVersionSummary[] }> {
    return this.agreements.list()
  }

  @Post('agreements')
  @HttpCode(201)
  publish(@CurrentOperator() operator: OpsPrincipal, @Body() dto: PublishAgreementDto): Promise<{ version: AgreementVersionView }> {
    return this.agreements.publish(operator, dto)
  }

  @Get('agreements/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<{ version: AgreementVersionView }> {
    return this.agreements.get(id)
  }

  @Get('tenants/:tenantId/agreements')
  forTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<TenantAgreementsView> {
    return this.agreements.forTenant(tenantId)
  }

  @Get('tenants/:tenantId/agreements/:versionId/pdf')
  async pdf(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('versionId', ParseUUIDPipe) versionId: string): Promise<StreamableFile> {
    const { pdf, filename } = await this.agreements.signedPdf(tenantId, versionId)
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="${filename}"` })
  }
}
