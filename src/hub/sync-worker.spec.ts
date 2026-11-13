// Hub sync worker (#304, H4) unit checks: the backoff ladder, and that the
// signer's headers pass the cloud's own verification (DeviceSyncGuard's parts).
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseEd25519PublicKey, signingString, verifyDeviceSignature } from '../platform'
import { devicePrivateKey, signatureHeaders } from './signer'
import { backoffMs } from './sync-worker'

describe('sync worker backoff', () => {
  it('doubles from 1 s and caps at 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
  })
})

describe('hub signer', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const cloudKey = parseEd25519PublicKey(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))!

  it('signs what the cloud verifies, body and query included, and nothing else', () => {
    const body = JSON.stringify({ batchId: 'x', ops: [{ note: 'ghee ₹' }] })
    const h = signatureHeaders(devicePrivateKey(pem), 'dev-1', 'POST', '/sync/v1/push', body, 1_700_000_000_000)
    expect(h['X-Device-Id']).toBe('dev-1')
    expect(h['X-Device-Timestamp']).toBe('1700000000000')
    const message = (path: string, raw: string | undefined) => signingString('POST', path, h['X-Device-Timestamp'], raw === undefined ? undefined : Buffer.from(raw))
    expect(verifyDeviceSignature(cloudKey, message('/sync/v1/push', body), h['X-Device-Signature'])).toBe(true)
    expect(verifyDeviceSignature(cloudKey, message('/sync/v1/push', `${body} `), h['X-Device-Signature'])).toBe(false)
    expect(verifyDeviceSignature(cloudKey, message('/sync/v1/pull', body), h['X-Device-Signature'])).toBe(false)

    const get = signatureHeaders(devicePrivateKey(pem), 'dev-1', 'GET', '/sync/v1/pull?cursor=12', undefined)
    expect(verifyDeviceSignature(cloudKey, signingString('GET', '/sync/v1/pull?cursor=12', get['X-Device-Timestamp'], undefined), get['X-Device-Signature'])).toBe(true)
  })

  it('refuses a key that is not ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(() => devicePrivateKey(rsa)).toThrow(/ed25519/)
  })
})
