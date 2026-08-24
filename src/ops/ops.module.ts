import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { OpsAuthController } from './auth.controller'
import { OpsAuthService } from './auth.service'

@Module({
  imports: [PlatformModule],
  controllers: [OpsAuthController],
  providers: [OpsAuthService],
})
export class OpsModule {}
