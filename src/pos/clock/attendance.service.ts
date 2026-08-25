// CAP-11: device and staff attendance status. Pure read over story 1's real
// ClockEvent rows - no new mutation model (stories.yaml story 11). "Clocked
// in" is the latest ClockEvent per staff member at this outlet being a
// clock_in with no later clock_out, scoped to today in the outlet's own
// local calendar day - reusing clock.util.ts's localDateKey, the exact same
// "today" definition CAP-1's once-per-day clock-in already relies on, so a
// clock-in just before local midnight isn't stranded on the wrong day here
// either.
import { Injectable, NotFoundException } from '@nestjs/common'
import { RegionRegistryService, type PosPrincipal } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { AttendanceStaffEntry, AttendanceView, MockedPrinterStatus } from './attendance.dtos'
import { localDateKey } from './clock.util'

// No real hardware in this prototype (SPEC.md Constraints) - see
// attendance.dtos.ts for why this is a static placeholder, not a live check.
const MOCK_PRINTER_STATUS: MockedPrinterStatus = { status: 'connected', mocked: true }

// Wide enough to catch every ClockEvent that could still land on "today" in
// any IANA timezone (max UTC offset spread is +14/-12) without scanning the
// whole insert-only table.
const LOOKBACK_HOURS = 48

@Injectable()
export class AttendanceService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async getAttendance(staff: PosPrincipal, outletId: string): Promise<AttendanceView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)

      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== staff.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      }

      const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000)
      const events = await tx.clockEvent.findMany({
        where: { tenantId: staff.tenantId, outletId, occurredAt: { gte: since } },
        orderBy: { occurredAt: 'desc' },
        include: { staff: true },
      })

      const todayKey = localDateKey(new Date(), outlet.timezone)
      const seenStaff = new Set<string>()
      const clockedIn: AttendanceStaffEntry[] = []
      for (const event of events) {
        // Events are ordered newest-first, so the first time we see a given
        // staffId here IS that staff member's latest event - skip the rest
        // of their history and never double-list a second same-day clock-in.
        if (seenStaff.has(event.staffId)) continue
        seenStaff.add(event.staffId)
        if (event.type !== 'clock_in') continue
        if (localDateKey(event.occurredAt, outlet.timezone) !== todayKey) continue
        clockedIn.push({ staffId: event.staffId, name: event.staff.name, clockedInAt: event.occurredAt.toISOString() })
      }
      clockedIn.sort((a, b) => a.name.localeCompare(b.name))

      return {
        outletId,
        asOf: new Date().toISOString(),
        staff: clockedIn,
        printerStatus: MOCK_PRINTER_STATUS,
      }
    })
  }
}
