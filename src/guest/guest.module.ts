import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { GuestSessionsController } from './sessions/sessions.controller'
import { GuestSessionsService } from './sessions/sessions.service'

@Module({
  imports: [PlatformModule],
  controllers: [GuestSessionsController],
  providers: [GuestSessionsService],
  // GuestSessionsService is consumed by pos/tables/tables.controller.ts for
  // the staff-side close (AD-2: cross-module reach only via this barrel).
  exports: [GuestSessionsService],
})
export class GuestModule {}
