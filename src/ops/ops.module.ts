import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { OpsAuthController } from './auth.controller'
import { OpsAuthService } from './auth.service'
import { OpsDashboardController } from './dashboard.controller'
import { OpsDevicesController } from './devices/devices.controller'
import { DevicesService } from './devices/devices.service'
import { OpsSubscriptionsController } from './subscriptions/subscriptions.controller'
import { SubscriptionsService } from './subscriptions/subscriptions.service'
import { TenantDirectoryService } from './tenants/directory.service'
import { OpsTenantsController } from './tenants/tenants.controller'
import { OpsTenantsService } from './tenants/tenants.service'

@Module({
  imports: [PlatformModule],
  controllers: [OpsAuthController, OpsDashboardController, OpsTenantsController, OpsDevicesController, OpsSubscriptionsController],
  providers: [OpsAuthService, OpsTenantsService, TenantDirectoryService, DevicesService, SubscriptionsService],
})
export class OpsModule {}
