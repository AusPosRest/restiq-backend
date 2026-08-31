// SPEC CAP-1 rate limit: 5 wrong-PIN join attempts against a given table
// locks joining THAT table for 30 seconds - same convention as
// pos/auth/lockout.ts, keyed by (outletId, tableId) rather than by session id
// since a wrong PIN might not even resolve to an open session yet (e.g. after
// staff close, or before the guest realizes the table was reset). In-memory
// Map: single-instance-only, an accepted tradeoff for this prototype (see
// pos/auth/lockout.ts's identical documented tradeoff).
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 30_000

interface Attempt {
  failures: number
  lockedUntil: number | null
}

const attempts = new Map<string, Attempt>()

function key(outletId: string, tableId: string): string {
  return `${outletId}:${tableId}`
}

/** True while this (outletId, tableId) pair is still serving out its lockout. */
export function isJoinLockedOut(outletId: string, tableId: string): boolean {
  const entry = attempts.get(key(outletId, tableId))
  if (!entry?.lockedUntil) return false
  if (Date.now() >= entry.lockedUntil) {
    attempts.delete(key(outletId, tableId))
    return false
  }
  return true
}

/** Records one more wrong PIN guess for this table; locks at 5. */
export function recordFailedJoinAttempt(outletId: string, tableId: string): void {
  const k = key(outletId, tableId)
  const entry = attempts.get(k) ?? { failures: 0, lockedUntil: null }
  entry.failures += 1
  if (entry.failures >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS
  }
  attempts.set(k, entry)
}

/** Clears any tracked failures once a join at this table succeeds. */
export function clearJoinAttempts(outletId: string, tableId: string): void {
  attempts.delete(key(outletId, tableId))
}
