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
// #132: one agreements implementation, published from /ops and signed from /admin.
export { AgreementsService } from './agreements/agreements.service'
export { StartSigningDto } from './agreements/agreements.dtos'
export type { AgreementSignatureView, OwnerAgreementView } from './agreements/agreements.dtos'
// #150: exported so the e2e suite can swap DocuSign for an in-memory fake.
export { DocuSignClient } from './agreements/docusign.client'
export type { EnvelopeSigner, EnvelopeState } from './agreements/docusign.client'
