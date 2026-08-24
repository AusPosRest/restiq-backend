import { Controller, Get } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { RoleView, StaffService } from './staff.service'

// Read-only reference for the staff/roles UI's permission matrix - the six
// system roles Platform Console seeds per tenant (CAP-7). No write route:
// free-text/custom roles are out of scope for v1.
@Controller('admin/v1/roles')
export class AdminRolesController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<RoleView[]> {
    return this.staff.listRoles(owner.tenantId)
  }
}
