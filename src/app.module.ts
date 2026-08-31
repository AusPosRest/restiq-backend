import { Module } from '@nestjs/common'
import { AdminModule } from './admin'
import { GuestModule } from './guest'
import { HealthController } from './health.controller'
import { KitchenModule } from './kitchen'
import { OpsModule } from './ops'
import { PlatformModule } from './platform'
import { PosModule } from './pos'

@Module({
  imports: [PlatformModule, OpsModule, AdminModule, PosModule, GuestModule, KitchenModule],
  controllers: [HealthController],
})
export class AppModule {}
