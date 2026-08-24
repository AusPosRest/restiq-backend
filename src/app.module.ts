import { Module } from '@nestjs/common'
import { HealthController } from './health.controller'
import { OpsModule } from './ops'
import { PlatformModule } from './platform'

@Module({
  imports: [PlatformModule, OpsModule],
  controllers: [HealthController],
})
export class AppModule {}
