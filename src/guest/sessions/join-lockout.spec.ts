import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearJoinAttempts, isJoinLockedOut, recordFailedJoinAttempt } from './join-lockout'

describe('guest join lockout (CAP-1: 5 wrong PIN attempts locks that table for 30s)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is not locked before any failures', () => {
    expect(isJoinLockedOut('outlet-1', 'table-1')).toBe(false)
  })

  it('stays unlocked through 4 failures and locks on the 5th', () => {
    for (let i = 0; i < 4; i++) recordFailedJoinAttempt('outlet-2', 'table-2')
    expect(isJoinLockedOut('outlet-2', 'table-2')).toBe(false)

    recordFailedJoinAttempt('outlet-2', 'table-2')
    expect(isJoinLockedOut('outlet-2', 'table-2')).toBe(true)
  })

  it('scopes the lock to the exact (outletId, tableId) pair', () => {
    for (let i = 0; i < 5; i++) recordFailedJoinAttempt('outlet-3', 'table-3')
    expect(isJoinLockedOut('outlet-3', 'table-3')).toBe(true)
    // A different table at the same outlet is untouched.
    expect(isJoinLockedOut('outlet-3', 'table-4')).toBe(false)
    // The same table id at a different outlet is untouched.
    expect(isJoinLockedOut('other-outlet', 'table-3')).toBe(false)
  })

  it('clears on a successful join', () => {
    for (let i = 0; i < 4; i++) recordFailedJoinAttempt('outlet-4', 'table-5')
    clearJoinAttempts('outlet-4', 'table-5')
    recordFailedJoinAttempt('outlet-4', 'table-5')
    // Counter restarted from zero - one failure after a clear isn't a lock.
    expect(isJoinLockedOut('outlet-4', 'table-5')).toBe(false)
  })

  it('unlocks automatically after 30 seconds', () => {
    for (let i = 0; i < 5; i++) recordFailedJoinAttempt('outlet-5', 'table-6')
    expect(isJoinLockedOut('outlet-5', 'table-6')).toBe(true)

    vi.advanceTimersByTime(29_999)
    expect(isJoinLockedOut('outlet-5', 'table-6')).toBe(true)

    vi.advanceTimersByTime(2)
    expect(isJoinLockedOut('outlet-5', 'table-6')).toBe(false)
  })
})
