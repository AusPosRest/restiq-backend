// SPEC CAP-1's other half of "clock in/out": clock-in is automatic on a
// successful login (clock.util.ts, called from auth.service.ts); clock-out
// is this explicit staff action, ending the day's open clock-in.
import { ConflictException, Injectable } from '@nestjs/common'
import { PosPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import type { Replay } from '../sync/replay'
import { setTenantContext } from '../tenant-context'
import { recordClockInIfNeeded } from './clock.util'
import { ClockEventView } from '../auth/auth.dtos'
import type { ClockEvent } from '../../generated/prisma/client'

function toView(row: ClockEvent): ClockEventView {
  return { id: row.id, type: row.type, occurredAt: row.occurredAt.toISOString() }
}

@Injectable()
export class ClockService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  /** restiq-backend#297: the clock-in the hub recorded when this staff member signed in there. */
  async clockIn(staff: PosPrincipal, replay: Replay): Promise<void> {
    await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const outlet = await tx.outlet.findFirstOrThrow({ where: { id: staff.outletId, tenantId: staff.tenantId }, select: { timezone: true } })
      await recordClockInIfNeeded(tx, { tenantId: staff.tenantId, staffId: staff.id, outletId: staff.outletId, timezone: outlet.timezone }, replay)
    })
  }

  // `replay` (restiq-backend#297): a clock-out the hub already recorded. It is
  // kept even if the cloud never saw the matching clock-in.
  async clockOut(staff: PosPrincipal, replay?: Replay): Promise<ClockEventView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const latest = await tx.clockEvent.findFirst({ where: { staffId: staff.id }, orderBy: { occurredAt: 'desc' } })
      if (!replay && (!latest || latest.type !== 'clock_in')) {
        throw new ConflictException({ code: 'not_clocked_in', message: 'You are not currently clocked in' })
      }
      const created = await tx.clockEvent.create({
        data: { id: replay?.id ?? uuidv7(), tenantId: staff.tenantId, staffId: staff.id, outletId: staff.outletId, type: 'clock_out', occurredAt: replay?.at ?? new Date() },
      })
      return toView(created)
    })
  }
}
