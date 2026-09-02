// CAP-4/AD-12/AD-13: the device-side half of enrolment - a browser page
// acting as the device redeems its own one-time code with no operator
// session at all. Reuses ops/devices' DevicesService.enrollWithActor (same
// one-time-use + expiry semantics, same Device row shape) rather than a
// second implementation - only the audit actor differs.
import { Injectable } from '@nestjs/common'
import { DevicesService, DeviceView } from '../../ops'
import { DeviceEnrollDto } from './device-enroll.dto'

const DEVICE_ACTOR_FINGERPRINT_CHARS = 12

@Injectable()
export class DeviceEnrollService {
  constructor(private readonly devices: DevicesService) {}

  enroll(dto: DeviceEnrollDto): Promise<{ device: DeviceView }> {
    // audit_events.actorEmail is required (NOT NULL) - there is no operator
    // email to put there, so a device actor gets a synthetic, non-PII label
    // instead. actorId stays null: no operator_users row backs this actor.
    const actorEmail = `device:${dto.hardwareKeyFingerprint.slice(0, DEVICE_ACTOR_FINGERPRINT_CHARS)}`
    return this.devices.enrollWithActor({ actorId: null, actorEmail }, dto)
  }
}
