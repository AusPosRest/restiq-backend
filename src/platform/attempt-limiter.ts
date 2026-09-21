// restiq-backend#171: one sign-in throttle for every secret we check (POS PIN,
// owner and operator passwords, manager PIN, guest table PIN). It replaces
// three in-memory Maps that reset on restart, weren't shared between
// instances, and - for the POS - were keyed by the guessed PIN, so rotating
// guesses never tripped them.
//
// Each attempt is counted BEFORE the secret is checked, in one atomic upsert
// per key (Postgres serialises concurrent upserts on the row), and refused
// once the key is over its limit - so a burst of parallel requests can't all
// slip past the check the way check-then-record allowed. A correct secret
// refunds its own count, so the counters end up holding failures only.
// Fixed window: once a key goes over, it stays refused until its window ends.
import { HttpException, Injectable } from '@nestjs/common'
import { RegionRegistryService } from './region-registry.service'

export interface AttemptRule {
  /** Opaque, fully-qualified key, e.g. `pos-pin:device:<tenantId>:<deviceId>`. */
  key: string
  /** Attempts allowed per window; the next one is refused. */
  max: number
  windowSeconds: number
}

// Rows older than this are dead (no window is this long) and get purged.
const PURGE_AFTER = '1 day'

@Injectable()
export class AttemptLimiter {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  /** Counts one attempt against every rule; throws 429 `locked_out` if any rule is now over its limit. */
  async consume(rules: readonly AttemptRule[]): Promise<void> {
    const plane = this.plane()
    for (const rule of rules) {
      const [row] = await plane.$queryRaw<{ attempts: number; retry_after: number }[]>`
        INSERT INTO auth_attempts (key, attempts, window_started_at)
        VALUES (${rule.key}, 1, now())
        ON CONFLICT (key) DO UPDATE SET
          attempts = CASE WHEN auth_attempts.window_started_at <= now() - ${rule.windowSeconds}::int * interval '1 second'
                          THEN 1 ELSE auth_attempts.attempts + 1 END,
          window_started_at = CASE WHEN auth_attempts.window_started_at <= now() - ${rule.windowSeconds}::int * interval '1 second'
                                   THEN now() ELSE auth_attempts.window_started_at END
        RETURNING attempts,
          GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_started_at + ${rule.windowSeconds}::int * interval '1 second' - now()))))::int AS retry_after`
      if (row.attempts > rule.max) {
        const minutes = Math.ceil(row.retry_after / 60)
        throw new HttpException(
          // retryAfterSeconds lets a sign-in screen count down to the real end of the window.
          { code: 'locked_out', message: `Too many incorrect attempts - try again in ${minutes} minute${minutes === 1 ? '' : 's'}`, retryAfterSeconds: row.retry_after },
          429,
        )
      }
    }
  }

  /** The secret was right: give back the attempts this request consumed, and sweep dead rows. */
  async refund(rules: readonly AttemptRule[]): Promise<void> {
    const plane = this.plane()
    const keys = rules.map((rule) => rule.key)
    await plane.$executeRaw`UPDATE auth_attempts SET attempts = GREATEST(attempts - 1, 0) WHERE key = ANY(${keys}::text[])`
    await plane.$executeRaw`DELETE FROM auth_attempts WHERE window_started_at < now() - ${PURGE_AFTER}::interval`
  }
}
