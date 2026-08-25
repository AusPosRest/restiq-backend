import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '../../generated/prisma/client'
import { localDateKey, recordClockInIfNeeded } from './clock.util'

describe('localDateKey', () => {
  it('reads the calendar date in the given timezone, not UTC', () => {
    // 23:30 UTC on Jan 1 is 05:00 the next day in Asia/Kolkata (+5:30).
    const instant = new Date('2026-01-01T23:30:00.000Z')
    expect(localDateKey(instant, 'UTC')).toBe('2026-01-01')
    expect(localDateKey(instant, 'Asia/Kolkata')).toBe('2026-01-02')
  })
})

interface ClockEventRow {
  type: 'clock_in' | 'clock_out'
  occurredAt: Date
}

describe('recordClockInIfNeeded', () => {
  let findFirst: ReturnType<typeof vi.fn<() => Promise<ClockEventRow | null>>>
  let create: ReturnType<typeof vi.fn<(args: { data: Record<string, unknown> }) => Promise<void>>>
  let tx: Prisma.TransactionClient

  beforeEach(() => {
    findFirst = vi.fn<() => Promise<ClockEventRow | null>>().mockResolvedValue(null)
    create = vi.fn<(args: { data: Record<string, unknown> }) => Promise<void>>().mockResolvedValue(undefined)
    tx = { clockEvent: { findFirst, create } } as unknown as Prisma.TransactionClient
  })

  const params = { tenantId: 't1', staffId: 's1', outletId: 'o1', timezone: 'Asia/Kolkata' }

  it('creates a clock-in when there is no prior event', async () => {
    await recordClockInIfNeeded(tx, params)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0].data.type).toBe('clock_in')
  })

  it('skips creating a clock-in when the latest event is already a clock-in today', async () => {
    findFirst.mockResolvedValue({ type: 'clock_in', occurredAt: new Date() })
    await recordClockInIfNeeded(tx, params)
    expect(create).not.toHaveBeenCalled()
  })

  it('creates a new clock-in when the latest clock-in was on an earlier local day', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    findFirst.mockResolvedValue({ type: 'clock_in', occurredAt: yesterday })
    await recordClockInIfNeeded(tx, params)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('creates a new clock-in when the latest event is a clock-out, even from today', async () => {
    findFirst.mockResolvedValue({ type: 'clock_out', occurredAt: new Date() })
    await recordClockInIfNeeded(tx, params)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
