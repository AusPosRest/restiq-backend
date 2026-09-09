import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import { AgreementsService, SignAgreementDto } from '../../ops'
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
