import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../db/client'
import { RegionRegistryService } from '../../platform'
import { SyncHealthService } from './sync-health.service'

const HOUR = 3600000

function setup() {
  const device = {
    id: 'device', tenantId: 'tenant', outletId: null, tenant: { name: 'Tenant' }, outlet: null,
    label: 'Till', type: 'pos', enrolledAt: new Date(Date.now() - 100 * HOUR),
    lastContactAt: new Date(Date.now() - 49 * HOUR), outboxDepth: null,
    appVersion: null, clockSkewSeconds: null, recentRejectionCount: null,
  }
  const tx = { $executeRaw: vi.fn(), device: { findMany: vi.fn(() => Promise.resolve([device])) } }
  const plane = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) }
  const registry = new RegionRegistryService({ client: plane as unknown as PrismaClient } as ConstructorParameters<typeof RegionRegistryService>[0])
  const notifySilentDevice = vi.fn(() => Promise.resolve())
  return { device, service: new SyncHealthService(registry, { notifySilentDevice }), notifySilentDevice }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

describe('silent-device sweep (#233)', () => {
  it('alerts once per silent period, including recovery between sweeps; list shares deduplication', async () => {
    vi.useFakeTimers()
    const { device, service, notifySilentDevice } = setup()
    await service.sweep()
    await service.sweep()
    await service.list({})
    expect(notifySilentDevice).toHaveBeenCalledTimes(1)
    device.lastContactAt = new Date()
    await service.sweep()
    vi.advanceTimersByTime(49 * HOUR)
    await service.sweep()
    expect(notifySilentDevice).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(HOUR)
    device.lastContactAt = new Date()
    vi.advanceTimersByTime(49 * HOUR)
    await service.sweep()
    expect(notifySilentDevice).toHaveBeenCalledTimes(3)
  })

  it('runs without page visits and clears its timer on shutdown', async () => {
    vi.useFakeTimers()
    vi.stubEnv('NODE_ENV', 'development')
    const { service, notifySilentDevice } = setup()
    service.onModuleInit()
    await vi.advanceTimersByTimeAsync(60000)
    expect(notifySilentDevice).toHaveBeenCalledTimes(1)
    service.onModuleDestroy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule automatically in tests', () => {
    vi.useFakeTimers()
    vi.stubEnv('NODE_ENV', 'test')
    const { service } = setup()
    service.onModuleInit()
    expect(vi.getTimerCount()).toBe(0)
  })
})
