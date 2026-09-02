// Public surface of the ops module - cross-module imports go through here.
export { OpsModule } from './ops.module'
export { ALERT_CHANNEL } from './sync-health/alert-channel'
export type { AlertChannel, SilentDeviceAlert } from './sync-health/alert-channel'
// tenant-admin/CAP-6 (AD-12): the one device/enrolment-code implementation,
// reused by admin/devices instead of a second one.
export { DevicesService } from './devices/devices.service'
export type { DeviceListItem, DeviceListResult, DeviceView, EnrollActor } from './devices/devices.service'
export { DEVICE_TYPES } from './devices/devices.dtos'
export type { DeviceTypeValue } from './devices/devices.dtos'
