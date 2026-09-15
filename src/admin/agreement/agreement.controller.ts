import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, StreamableFile } from '@nestjs/common'
import { AgreementsService, StartSigningDto } from '../../ops'
import type { OwnerAgreementView } from '../../ops'
import { AdminPrincipal, CurrentOwner } from '../../platform'

// Owner side of issues #132/#150: read the current agreement, open a DocuSign
// signing session on it, download the sealed PDF once it is complete. Calls
// the ops module's AgreementsService directly (AD-12: one implementation, two
// callers) rather than a second one.
@Controller('admin/v1/agreement')
export class AdminAgreementController {
  constructor(private readonly agreements: AgreementsService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal): Promise<OwnerAgreementView> {
    return this.agreements.ownerView(owner)
  }

  @Post(':versionId/signing')
  @HttpCode(201)
  startSigning(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: StartSigningDto,
  ): Promise<{ url: string }> {
    return this.agreements.startSigning(owner, versionId, dto)
  }

  @Get(':versionId/pdf')
  async pdf(@CurrentOwner() owner: AdminPrincipal, @Param('versionId', ParseUUIDPipe) versionId: string): Promise<StreamableFile> {
    const { pdf, filename } = await this.agreements.signedPdf(owner.tenantId, versionId)
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="${filename}"` })
  }
}
