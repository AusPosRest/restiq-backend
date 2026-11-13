// The hub's utilityProcess port (#307, restiq-desktop D3): an early device key
// is held until the hub is ready, and the status message's shape and lock
// agree with GET /pos/v1/hub/status.
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from '../platform'
import { listenToParent, statusMessage, type DeviceKeyMessage, type ParentPort } from './desktop-port'
import { createMetaTable } from './meta'
import { createOutboxTable } from './outbox'

function fakePort() {
  let listener: (event: { data: unknown }) => void = () => undefined
  const port: ParentPort = { on: (_event, next) => (listener = next), postMessage: vi.fn() }
  return { port, send: (data: unknown) => listener({ data }) }
}

describe('parent port listener', () => {
  it('holds a device key sent before the hub is ready, then hands it over once', () => {
    const { port, send } = fakePort()
    const shutdown = vi.fn()
    const parent = listenToParent(port, shutdown)
    const key: DeviceKeyMessage = { type: 'device-key', pem: 'PEM', deviceId: 'd1' }
    send(key)
    send({ type: 'device-key' }) // no pem: ignored
    const handler = vi.fn()
    parent.onDeviceKey(handler)
    expect(handler).toHaveBeenCalledExactlyOnceWith(key)
    send({ ...key, pem: 'PEM2' })
    expect(handler).toHaveBeenLastCalledWith({ ...key, pem: 'PEM2' })
    expect(handler).toHaveBeenCalledTimes(2)
    send({ type: 'shutdown' })
    expect(shutdown).toHaveBeenCalledOnce()
  })
})

describe('status message', () => {
  let pg: PGlite
  beforeAll(async () => {
    pg = await PGlite.create()
    await createMetaTable(pg)
    await createOutboxTable(pg)
  })
  afterAll(() => pg.close())

  it('reports an empty hub before bootstrap', async () => {
    expect(await statusMessage(pg, undefined, new Date())).toEqual({
      type: 'status',
      online: false,
      lastSyncAt: null,
      outboxDepth: 0,
      locked: false,
      lockReason: null,
      lastError: null,
      bootstrapped: false,
      tenantId: null,
      mustSyncBefore: null,
    })
  })

  it('carries ISO dates and the offline lock 24 h + 1 s after the last sync', async () => {
    const tenantId = uuidv7()
    const last = new Date('2026-11-01T00:00:00.000Z')
    await pg.query(
      `INSERT INTO hub_meta (tenant_id, outlet_id, cursor, policy, permissions, last_sync_at, online)
       VALUES ($1, $2, 0, '{"maxOfflineHours": 24, "syncIntervalSeconds": 30}', '{}', $3, false)`,
      [tenantId, uuidv7(), last],
    )
    const message = await statusMessage(pg, undefined, new Date(last.getTime() + 24 * 3_600_000 + 1000))
    expect(message).toEqual({
      type: 'status',
      online: false,
      lastSyncAt: '2026-11-01T00:00:00.000Z',
      outboxDepth: 0,
      locked: true,
      lockReason: 'offline_limit',
      lastError: null,
      bootstrapped: true,
      tenantId,
      mustSyncBefore: '2026-11-02T00:00:00.000Z',
    })
  })
})
