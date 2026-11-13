// Offline sync device realm (restiq-backend#185, docs/SYNC-DESIGN.md §9).
// A hub till signs every /sync/v1 request with the ed25519 key whose public
// half it sent with its one-time enrolment code. Plain node:crypto - no
// dependency.
import { createHash, createPublicKey, KeyObject, verify } from 'node:crypto'

/** How far a request's timestamp may be from the server clock. */
export const SIGNATURE_SKEW_MS = 5 * 60 * 1000

/** The base64 SPKI DER ed25519 key, or null for anything else. */
export function parseEd25519PublicKey(base64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch {
    return null
  }
}

/** What the device signs: method, path with query, timestamp, body hash. */
export function signingString(method: string, pathWithQuery: string, timestamp: string, body: Buffer | undefined): string {
  const bodyHash = createHash('sha256')
    .update(body ?? Buffer.alloc(0))
    .digest('hex')
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`
}

export function verifyDeviceSignature(publicKey: KeyObject, message: string, signatureBase64: string): boolean {
  try {
    return verify(null, Buffer.from(message), publicKey, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}
