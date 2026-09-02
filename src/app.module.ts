import { Module } from '@nestjs/common'
import { AdminModule } from './admin'
import { DeviceModule } from './device'
import { GuestModule } from './guest'
import { HealthController } from './health.controller'
import { KitchenModule } from './kitchen'
import { OpsModule } from './ops'
import { PlatformModule } from './platform'
import { PosModule } from './pos'

@Module({
  imports: [PlatformModule, OpsModule, AdminModule, PosModule, GuestModule, KitchenModule, DeviceModule],
  controllers: [HealthController],
})
export class AppModule {}
