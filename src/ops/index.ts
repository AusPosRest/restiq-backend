// Public surface of the ops module - cross-module imports go through here.
export { OpsModule } from './ops.module'
export { ALERT_CHANNEL } from './sync-health/alert-channel'
export type { AlertChannel, SilentDeviceAlert } from './sync-health/alert-channel'
