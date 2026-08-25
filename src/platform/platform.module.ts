import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { AdminAuthGuard } from './admin-auth.guard'
import { ApiErrorFilter } from './api-error.filter'
import { ControlPlaneAuditService } from './audit.service'
import { OpsAuthGuard } from './ops-auth.guard'
import { PosAuthGuard } from './pos-auth.guard'
import { PrismaService } from './prisma.service'
import { RegionRegistryService } from './region-registry.service'

@Module({
  providers: [
    PrismaService,
    ControlPlaneAuditService,
    RegionRegistryService,
    { provide: APP_GUARD, useClass: OpsAuthGuard },
    // AD-10: a second, disjoint global guard for /admin/* - each early-returns
    // true outside its own prefix, so both combine without interfering.
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    // AD-13: a third, disjoint global guard for /pos/* - same early-return
    // shape, so all three combine without interfering.
    { provide: APP_GUARD, useClass: PosAuthGuard },
    { provide: APP_FILTER, useClass: ApiErrorFilter },
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true }) },
  ],
  exports: [PrismaService, ControlPlaneAuditService, RegionRegistryService],
})
export class PlatformModule {}
