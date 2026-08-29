// qr-self-order/CAP-1 staff-side close (AD-17): staff can end a table's guest
// session directly from the pos realm - lifecycle close, alongside
// settlement and the idle-TTL backstop. Delegates to GuestSessionsService
// (the guest module's own barrel export) rather than reimplementing
// TableSession writes here - AD-2's "one owner per model" extended across
// the realm boundary.
import { Controller, HttpCode, Param, Post } from '@nestjs/common'
import { GuestSessionsService } from '../../guest'
import { CurrentStaff, PosPrincipal } from '../../platform'

@Controller('pos/v1/tables')
export class PosTablesController {
  constructor(private readonly guestSessions: GuestSessionsService) {}

  @Post(':tableId/close-session')
  @HttpCode(200)
  closeSession(@CurrentStaff() staff: PosPrincipal, @Param('tableId') tableId: string): Promise<{ closed: true }> {
    return this.guestSessions.closeSessionForStaff(staff.tenantId, staff.outletId, tableId).then(() => ({ closed: true as const }))
  }
}
