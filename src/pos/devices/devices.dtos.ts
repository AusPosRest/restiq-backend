import { IsOptional, IsUUID } from 'class-validator'

// Device topology (issue #134): the sending POS tab's own device, so its work
// routes to that POS's linked printer/terminal. Absent = the outlet-wide queue.
export class DeviceSourceDto {
  @IsOptional() @IsUUID()
  deviceId?: string
}
