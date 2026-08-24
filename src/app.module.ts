import { Module } from '@nestjs/common'
import { AdminModule } from './admin'
import { HealthController } from './health.controller'
import { OpsModule } from './ops'
import { PlatformModule } from './platform'

@Module({
  imports: [PlatformModule, OpsModule, AdminModule],
  controllers: [HealthController],
})
export class AppModule {}
