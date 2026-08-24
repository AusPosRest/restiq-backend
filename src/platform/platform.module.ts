import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { ApiErrorFilter } from './api-error.filter'
import { ControlPlaneAuditService } from './audit.service'
import { OpsAuthGuard } from './ops-auth.guard'
import { PrismaService } from './prisma.service'
import { RegionRegistryService } from './region-registry.service'

@Module({
  providers: [
    PrismaService,
    ControlPlaneAuditService,
    RegionRegistryService,
    { provide: APP_GUARD, useClass: OpsAuthGuard },
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true }) },
  ],
  exports: [PrismaService, ControlPlaneAuditService, RegionRegistryService],
})
export class PlatformModule {}
