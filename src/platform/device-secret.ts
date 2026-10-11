// restiq-backend#209 (SE-12): the secret a device gets once at enrolment. Only its sha256 is stored;
// a PIN sign-in that presents it proves it comes from that enrolled device, not just something that knows its id.
import { createHash, timingSafeEqual } from 'node:crypto'

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function deviceSecretMatches(secret: string | undefined, storedHash: string | null): boolean {
  if (!secret || !storedHash) return false
  const given = Buffer.from(hashDeviceSecret(secret))
  const stored = Buffer.from(storedHash)
  return given.length === stored.length && timingSafeEqual(given, stored)
}
