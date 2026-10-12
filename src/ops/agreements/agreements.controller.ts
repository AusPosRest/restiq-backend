import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { AgreementVersionSummary, AgreementVersionView, MAX_AGREEMENT_PDF_BYTES, PublishAgreementDto, TenantAgreementsView } from './agreements.dtos'
import { AgreementsService, safeFileName } from './agreements.service'

/** The PDF, shown inline by the browser's viewer. nosniff so it is never treated as anything else. */
export function pdfResponse(file: { bytes: Buffer; fileName: string }): StreamableFile {
  return new StreamableFile(file.bytes, { type: 'application/pdf', disposition: `inline; filename="${safeFileName(file.fileName)}"`, length: file.bytes.length })
}

// Platform-wide versions under ops/v1/agreements; a tenant's standing nested
// under the owning tenant per the URL convention (same as subscription).
@Controller('ops/v1')
export class OpsAgreementsController {
  constructor(private readonly agreements: AgreementsService) {}

  @Get('agreements')
  list(): Promise<{ versions: AgreementVersionSummary[] }> {
    return this.agreements.list()
  }

  // multipart/form-data: title, reason and the PDF in `file` (max 5 MB).
  @Post('agreements')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_AGREEMENT_PDF_BYTES, files: 1 } }))
  publish(
    @CurrentOperator() operator: OpsPrincipal,
    @Body() dto: PublishAgreementDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ version: AgreementVersionView }> {
    if (!file) throw new BadRequestException({ code: 'file_required', message: 'Attach the agreement as a PDF file' })
    return this.agreements.publish(operator, dto, file)
  }

  @Get('agreements/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<{ version: AgreementVersionView }> {
    return this.agreements.get(id)
  }

  @Get('agreements/:id/file')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  async file(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    return pdfResponse(await this.agreements.file(id))
  }

  @Get('tenants/:tenantId/agreements')
  forTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<TenantAgreementsView> {
    return this.agreements.forTenant(tenantId)
  }
}
