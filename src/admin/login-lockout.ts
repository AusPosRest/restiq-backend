// Owner password login (issue #118): 5 failed attempts for the same
// normalized email locks that email out for 30 seconds. Keyed by email
// rather than by resolved owner row - the lockout has to apply before we
// know whether the email matches any OwnerUser at all (same reasoning as
// pos/auth/lockout.ts keying on the guessed PIN, not a resolved staff row).
// In-memory Map: single-instance-only, an accepted tradeoff for this
// prototype (same as pos/auth/lockout.ts and guest sessions' join-attempt
// tracker) - not durable across restarts or multiple instances.
const MAX_ATTEMPTS = 5

// Overridable by tests so a lockout-expiry assertion doesn't need a 30s sleep.
let lockoutMs = 30_000

export function setLockoutMsForTesting(ms: number): void {
  lockoutMs = ms
}

interface Attempt {
  failures: number
  lockedUntil: number | null
}

const attempts = new Map<string, Attempt>()

/** True while this normalized email is still serving out its lockout. */
export function isLockedOut(email: string): boolean {
  const entry = attempts.get(email)
  if (!entry?.lockedUntil) return false
  if (Date.now() >= entry.lockedUntil) {
    attempts.delete(email)
    return false
  }
  return true
}

/** Records one more failed login for this email; locks at 5. */
export function recordFailedAttempt(email: string): void {
  const entry = attempts.get(email) ?? { failures: 0, lockedUntil: null }
  entry.failures += 1
  if (entry.failures >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + lockoutMs
  }
  attempts.set(email, entry)
}

/** Clears any tracked failures once this email logs in successfully. */
export function clearAttempts(email: string): void {
  attempts.delete(email)
}
