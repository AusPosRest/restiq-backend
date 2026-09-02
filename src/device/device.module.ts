import { Module } from '@nestjs/common'
import { OpsModule } from '../ops'
import { DeviceEnrollController } from './enroll/device-enroll.controller'
import { DeviceEnrollService } from './enroll/device-enroll.service'
import { EnrollRateLimitGuard } from './enroll/enroll-rate-limit.guard'

// The public device realm (issue #89): a web page acting as a device, with
// no session of its own. Imports OpsModule only to reuse its exported
// DevicesService (AD-12: one enrolment implementation, now three callers) -
// this module adds no device/enrolment-code logic of its own.
@Module({
  imports: [OpsModule],
  controllers: [DeviceEnrollController],
  providers: [DeviceEnrollService, EnrollRateLimitGuard],
})
export class DeviceModule {}
