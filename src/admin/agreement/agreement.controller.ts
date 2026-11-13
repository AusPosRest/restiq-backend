import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, StreamableFile } from '@nestjs/common'
import { AgreementsService, pdfResponse, SignAgreementDto } from '../../ops'
import type { AgreementSignatureView, OwnerAgreementView } from '../../ops'
import { AdminPrincipal, CurrentOwner } from '../../platform'

// Owner side of issue #132: read the current agreement, sign it. Calls the
// ops module's AgreementsService directly (AD-12: one implementation, two
// callers) rather than a second one.
@Controller('admin/v1/agreement')
export class AdminAgreementController {
  constructor(private readonly agreements: AgreementsService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal): Promise<OwnerAgreementView> {
    return this.agreements.ownerView(owner)
  }

  // The PDF to read before signing; the browser's own viewer shows it.
  @Get(':versionId/file')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  async file(@Param('versionId', ParseUUIDPipe) versionId: string): Promise<StreamableFile> {
    return pdfResponse(await this.agreements.file(versionId))
  }

  @Post(':versionId/sign')
  @HttpCode(201)
  sign(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: SignAgreementDto,
  ): Promise<{ signature: AgreementSignatureView }> {
    return this.agreements.sign(owner, versionId, dto)
  }
}
