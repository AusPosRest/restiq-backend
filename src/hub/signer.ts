// Hub mode (#304, HUB-BUILD-PLAN H4): signs the sync worker's /sync/v1 calls
// with the device's ed25519 key, over the backend's own signingString - the
// same bytes DeviceSyncGuard verifies (SYNC-DESIGN §9).
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { signingString } from '../platform'

/** The PKCS#8 PEM the desktop sends, as a key; throws for anything but ed25519. */
export function devicePrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the device key must be an ed25519 private key')
  return key
}

/** X-Device-* headers for one request. pathWithQuery is exactly what the cloud sees as originalUrl. */
export function signatureHeaders(key: KeyObject, deviceId: string, method: string, pathWithQuery: string, body: string | undefined, now = Date.now()): Record<string, string> {
  const timestamp = String(now)
  const message = signingString(method, pathWithQuery, timestamp, body === undefined ? undefined : Buffer.from(body))
  return { 'X-Device-Id': deviceId, 'X-Device-Timestamp': timestamp, 'X-Device-Signature': sign(null, Buffer.from(message), key).toString('base64') }
}
