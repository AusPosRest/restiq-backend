import { Module } from '@nestjs/common'
import { PlatformModule } from '../platform'
import { OpsAgreementsController } from './agreements/agreements.controller'
import { AgreementsService } from './agreements/agreements.service'
import { OpsAuthController } from './auth.controller'
import { OpsAuthService } from './auth.service'
import { OpsDashboardController } from './dashboard.controller'
import { OpsDevicesController } from './devices/devices.controller'
import { DevicesService } from './devices/devices.service'
import { OpsDlqController } from './dlq/dlq.controller'
import { DlqService } from './dlq/dlq.service'
import { OpsSubscriptionsController } from './subscriptions/subscriptions.controller'
import { SubscriptionsService } from './subscriptions/subscriptions.service'
import { ALERT_CHANNEL, LogAlertChannel } from './sync-health/alert-channel'
import { OpsSyncHealthController } from './sync-health/sync-health.controller'
import { SyncHealthService } from './sync-health/sync-health.service'
import { TenantDirectoryService } from './tenants/directory.service'
import { OpsTenantsController } from './tenants/tenants.controller'
import { OpsTenantsService } from './tenants/tenants.service'

@Module({
  imports: [PlatformModule],
  controllers: [
    OpsAuthController,
    OpsDashboardController,
    OpsTenantsController,
    OpsDevicesController,
    OpsSubscriptionsController,
    OpsSyncHealthController,
    OpsDlqController,
    OpsAgreementsController,
  ],
  providers: [
    OpsAuthService,
    OpsTenantsService,
    TenantDirectoryService,
    DevicesService,
    SubscriptionsService,
    SyncHealthService,
    DlqService,
    AgreementsService,
    { provide: ALERT_CHANNEL, useClass: LogAlertChannel },
  ],
  // DevicesService is exported for tenant-admin/CAP-6 (AD-12: one enrolment
  // implementation, two callers) - admin/devices calls it directly rather
  // than reimplementing enrolment-code generation or fleet queries.
  // AgreementsService likewise: admin/agreement signs through the same service that ops publishes with (#132).
  exports: [DevicesService, AgreementsService],
})
export class OpsModule {}
