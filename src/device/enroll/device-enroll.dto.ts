// Device realm (AD-12/AD-13): a browser page stands in for a real device and
// redeems its own enrolment code, so there is no `reason` field here (that's
// an ops/admin operator concept, not something a device supplies).
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator'

export class DeviceEnrollDto {
  @IsString() @IsNotEmpty() @MaxLength(20)
  code!: string

  @IsString() @IsNotEmpty() @MaxLength(200)
  hardwareKeyFingerprint!: string

  @IsOptional() @IsString() @MaxLength(100)
  label?: string

  // Offline sync (restiq-backend#185): the device's ed25519 public key, base64
  // SPKI DER. The one-time code is the trust anchor, so the key rides on it.
  @IsOptional() @IsString() @MaxLength(200)
  publicKey?: string
}
