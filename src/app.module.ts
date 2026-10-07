import { Module } from '@nestjs/common'
import { AdminModule } from './admin'
import { DeviceModule } from './device'
import { GuestModule } from './guest'
import { DevInboxController } from './dev-inbox.controller'
import { HealthController } from './health.controller'
import { KitchenModule } from './kitchen'
import { OpsModule } from './ops'
import { PlatformModule } from './platform'
import { PosModule } from './pos'
import { TenancyModule } from './tenancy/tenancy.module'

@Module({
  imports: [PlatformModule, OpsModule, AdminModule, PosModule, GuestModule, KitchenModule, DeviceModule, TenancyModule],
  controllers: [HealthController, DevInboxController],
})
export class AppModule {}
