import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { OpsAuthController } from './auth.controller'
import { OpsAuthService } from './auth.service'
import { OpsDashboardController } from './dashboard.controller'
import { TenantDirectoryService } from './tenants/directory.service'
import { OpsTenantsController } from './tenants/tenants.controller'
import { OpsTenantsService } from './tenants/tenants.service'

@Module({
  imports: [PlatformModule],
  controllers: [OpsAuthController, OpsDashboardController, OpsTenantsController],
  providers: [OpsAuthService, OpsTenantsService, TenantDirectoryService],
})
export class OpsModule {}
