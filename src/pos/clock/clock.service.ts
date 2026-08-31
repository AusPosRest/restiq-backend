// SPEC CAP-1's other half of "clock in/out": clock-in is automatic on a
// successful login (clock.util.ts, called from auth.service.ts); clock-out
// is this explicit staff action, ending the day's open clock-in.
import { ConflictException, Injectable } from '@nestjs/common'
import { PosPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { setTenantContext } from '../tenant-context'
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

  async clockOut(staff: PosPrincipal): Promise<ClockEventView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const latest = await tx.clockEvent.findFirst({ where: { staffId: staff.id }, orderBy: { occurredAt: 'desc' } })
      if (!latest || latest.type !== 'clock_in') {
        throw new ConflictException({ code: 'not_clocked_in', message: 'You are not currently clocked in' })
      }
      const created = await tx.clockEvent.create({
        data: { id: uuidv7(), tenantId: staff.tenantId, staffId: staff.id, outletId: staff.outletId, type: 'clock_out', occurredAt: new Date() },
      })
      return toView(created)
    })
  }
}
