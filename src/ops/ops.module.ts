import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { OpsAuthController } from './auth.controller'
import { OpsAuthService } from './auth.service'
import { OpsTenantsController } from './tenants/tenants.controller'
import { OpsTenantsService } from './tenants/tenants.service'

@Module({
  imports: [PlatformModule],
  controllers: [OpsAuthController, OpsTenantsController],
  providers: [OpsAuthService, OpsTenantsService],
})
export class OpsModule {}
