import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { AdminAuthController } from './auth.controller'
import { AdminAuthService } from './auth.service'
import { AdminChecklistController } from './checklist/checklist.controller'
import { ChecklistService } from './checklist/checklist.service'

@Module({
  imports: [PlatformModule],
  controllers: [AdminAuthController, AdminChecklistController],
  providers: [AdminAuthService, ChecklistService],
})
export class AdminModule {}
