// SPEC CAP-1: 5 wrong PIN attempts locks THAT PIN for 30 seconds. Keyed by
// (tenantId, pin) rather than by staff member - a brute-force guess can't be
// attributed to one staff row until it succeeds, so the lock has to sit on
// the guess itself. In-memory Map: single-instance-only, an accepted
// tradeoff for this prototype (documented, not a schema migration).
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 30_000

interface Attempt {
  failures: number
  lockedUntil: number | null
}

const attempts = new Map<string, Attempt>()

function key(tenantId: string, pin: string): string {
  return `${tenantId}:${pin}`
}

/** True while this (tenantId, pin) pair is still serving out its lockout. */
export function isLockedOut(tenantId: string, pin: string): boolean {
  const entry = attempts.get(key(tenantId, pin))
  if (!entry?.lockedUntil) return false
  if (Date.now() >= entry.lockedUntil) {
    attempts.delete(key(tenantId, pin))
    return false
  }
  return true
}

/** Records one more wrong guess of this PIN for this tenant; locks at 5. */
export function recordFailedAttempt(tenantId: string, pin: string): void {
  const k = key(tenantId, pin)
  const entry = attempts.get(k) ?? { failures: 0, lockedUntil: null }
  entry.failures += 1
  if (entry.failures >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS
  }
  attempts.set(k, entry)
}

/** Clears any tracked failures once this exact PIN succeeds for this tenant. */
export function clearAttempts(tenantId: string, pin: string): void {
  attempts.delete(key(tenantId, pin))
}
