import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { OpsAuthController } from './auth.controller'
import { OpsAuthService } from './auth.service'
import { OpsDashboardController } from './dashboard.controller'
import { OpsDevicesController } from './devices/devices.controller'
import { DevicesService } from './devices/devices.service'
import { TenantDirectoryService } from './tenants/directory.service'
import { OpsTenantsController } from './tenants/tenants.controller'
import { OpsTenantsService } from './tenants/tenants.service'

@Module({
  imports: [PlatformModule],
  controllers: [OpsAuthController, OpsDashboardController, OpsTenantsController, OpsDevicesController],
  providers: [OpsAuthService, OpsTenantsService, TenantDirectoryService, DevicesService],
})
export class OpsModule {}
