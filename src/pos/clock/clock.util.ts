// SPEC CAP-1: "a clock-in event if none is open for that staff member
// today" - "today" is the outlet's local calendar day (Outlet.timezone), not
// UTC or the server's clock, so a clock-in just before local midnight isn't
// double-counted on the next login.
import type { Prisma } from '../../generated/prisma/client'
import { uuidv7 } from '../../platform'

/** yyyy-mm-dd for `date` in `timezone` - en-CA formats as ISO order. */
export function localDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export interface ClockInParams {
  tenantId: string
  staffId: string
  outletId: string
  timezone: string
}

/**
 * Records a clock-in unless the staff member's latest event is already a
 * clock-in on today's local date - CAP-1's "once per day" success criterion.
 * Runs inside the caller's own transaction (post-login), same shape as every
 * other tenant-scoped write in this codebase.
 */
export async function recordClockInIfNeeded(tx: Prisma.TransactionClient, params: ClockInParams): Promise<void> {
  const latest = await tx.clockEvent.findFirst({ where: { staffId: params.staffId }, orderBy: { occurredAt: 'desc' } })
  const now = new Date()
  if (latest?.type === 'clock_in' && localDateKey(latest.occurredAt, params.timezone) === localDateKey(now, params.timezone)) {
    return
  }
  await tx.clockEvent.create({
    data: { id: uuidv7(), tenantId: params.tenantId, staffId: params.staffId, outletId: params.outletId, type: 'clock_in', occurredAt: now },
  })
}
