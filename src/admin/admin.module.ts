import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { AdminAuthController } from './auth.controller'
import { AdminAuthService } from './auth.service'
import { AdminChecklistController } from './checklist/checklist.controller'
import { ChecklistService } from './checklist/checklist.service'
import { AdminMenuImportController } from './menu-import/menu-import.controller'
import { MenuImportService } from './menu-import/menu-import.service'

@Module({
  imports: [PlatformModule],
  controllers: [AdminAuthController, AdminChecklistController, AdminMenuImportController],
  providers: [AdminAuthService, ChecklistService, MenuImportService],
})
export class AdminModule {}
