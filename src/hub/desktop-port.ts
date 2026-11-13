// Hub mode (#307, H6 + restiq-desktop D3): the hub's side of Electron's
// utilityProcess port. The listener goes on before the store opens, so a
// device key the parent sends early waits instead of being lost; status
// messages carry the same lock computation as GET /pos/v1/hub/status.
import type { PGlite } from '@electric-sql/pglite'
import { lockState, type LockReason } from './lock.guard'
import { outboxDepth } from './outbox'
import type { SyncWorker } from './sync-worker'

export interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export interface DeviceKeyMessage {
  type: 'device-key'
  pem: string
  deviceId?: string
  cloudUrl?: string
  appVersion?: string
}

export interface StatusMessage {
  type: 'status'
  online: boolean
  lastSyncAt: string | null
  outboxDepth: number
  locked: boolean
  lockReason: LockReason | null
  lastError: string | null
  bootstrapped: boolean
  tenantId: string | null
  mustSyncBefore: string | null
}

/** Handles shutdown at once; holds a device-key until onDeviceKey is given a handler. */
export function listenToParent(port: ParentPort | undefined, shutdown: () => void): { onDeviceKey(handler: (message: DeviceKeyMessage) => void): void } {
  let early: DeviceKeyMessage | undefined
  let handler: ((message: DeviceKeyMessage) => void) | undefined
  port?.on('message', ({ data }) => {
    const message = data as { type?: unknown; pem?: unknown } | null
    if (message?.type === 'shutdown') shutdown()
    else if (message?.type === 'device-key' && typeof message.pem === 'string') {
      if (handler) handler(message as DeviceKeyMessage)
      else early = message as DeviceKeyMessage
    }
  })
  return {
    onDeviceKey(next) {
      handler = next
      if (early) next(early)
      early = undefined
    },
  }
}

export async function statusMessage(pg: Pick<PGlite, 'query'>, worker: SyncWorker | undefined, now: Date): Promise<StatusMessage> {
  const { meta, mustSyncBefore, lockReason } = await lockState(pg, now)
  return {
    type: 'status',
    online: meta?.online ?? false,
    lastSyncAt: meta?.lastSyncAt?.toISOString() ?? null,
    outboxDepth: await outboxDepth(pg),
    locked: lockReason !== null,
    lockReason,
    lastError: worker?.lastError ?? null,
    bootstrapped: meta !== undefined,
    tenantId: meta?.tenantId ?? null,
    mustSyncBefore: mustSyncBefore?.toISOString() ?? null,
  }
}
