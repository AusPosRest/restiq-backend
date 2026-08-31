import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAttempts, isLockedOut, recordFailedAttempt } from './lockout'

describe('pos lockout (CAP-1: 5 wrong attempts locks that PIN for 30s)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is not locked before any failures', () => {
    expect(isLockedOut('tenant-1', '1111')).toBe(false)
  })

  it('stays unlocked through 4 failures and locks on the 5th', () => {
    for (let i = 0; i < 4; i++) recordFailedAttempt('tenant-2', '2222')
    expect(isLockedOut('tenant-2', '2222')).toBe(false)

    recordFailedAttempt('tenant-2', '2222')
    expect(isLockedOut('tenant-2', '2222')).toBe(true)
  })

  it('scopes the lock to the exact (tenantId, pin) pair', () => {
    for (let i = 0; i < 5; i++) recordFailedAttempt('tenant-3', '3333')
    expect(isLockedOut('tenant-3', '3333')).toBe(true)
    // A different guessed PIN for the same tenant is untouched.
    expect(isLockedOut('tenant-3', '4444')).toBe(false)
    // The same guessed PIN for a different tenant is untouched.
    expect(isLockedOut('other-tenant', '3333')).toBe(false)
  })

  it('clears on a successful attempt', () => {
    for (let i = 0; i < 4; i++) recordFailedAttempt('tenant-4', '5555')
    clearAttempts('tenant-4', '5555')
    recordFailedAttempt('tenant-4', '5555')
    // Counter restarted from zero - one failure after a clear isn't a lock.
    expect(isLockedOut('tenant-4', '5555')).toBe(false)
  })

  it('unlocks automatically after 30 seconds', () => {
    for (let i = 0; i < 5; i++) recordFailedAttempt('tenant-5', '6666')
    expect(isLockedOut('tenant-5', '6666')).toBe(true)

    vi.advanceTimersByTime(29_999)
    expect(isLockedOut('tenant-5', '6666')).toBe(true)

    vi.advanceTimersByTime(2)
    expect(isLockedOut('tenant-5', '6666')).toBe(false)
  })
})
