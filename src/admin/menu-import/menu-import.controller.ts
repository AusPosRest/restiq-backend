import { BadRequestException, Body, Controller, HttpCode, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { MenuImportCommitResult, MenuImportDraftView, PatchMenuImportDraftDto } from './menu-import.dtos'
import { MenuImportService } from './menu-import.service'
import { MAX_UPLOAD_BYTES } from './upload-validation'

@Controller('admin/v1/menu-import')
export class AdminMenuImportController {
  constructor(private readonly menuImport: MenuImportService) {}

  @Post('upload')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@CurrentOwner() owner: AdminPrincipal, @UploadedFile() file?: Express.Multer.File): Promise<MenuImportDraftView> {
    if (!file) {
      throw new BadRequestException({ code: 'validation_failed', message: 'A file is required' })
    }
    return this.menuImport.upload(owner, file)
  }

  @Patch(':importId')
  patch(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('importId') importId: string,
    @Body() dto: PatchMenuImportDraftDto,
  ): Promise<MenuImportDraftView> {
    return this.menuImport.patch(owner, importId, dto.items)
  }

  @Post(':importId/commit')
  @HttpCode(201)
  commit(@CurrentOwner() owner: AdminPrincipal, @Param('importId') importId: string): Promise<MenuImportCommitResult> {
    return this.menuImport.commit(owner, importId)
  }
}
