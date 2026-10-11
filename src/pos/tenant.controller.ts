// restiq-backend#213: the signed-in staff member's tenant - its name and whether it is in Test mode - so the
// POS and KDS headers can show a TEST badge.
import { Controller, Get } from '@nestjs/common'
import { AnyStaff, CurrentStaff, PosPrincipal, readTenantSummary, RegionRegistryService, TenantSummary } from '../platform'
import { setTenantContext } from './tenant-context'

@Controller('pos/v1/tenant')
export class PosTenantController {
  constructor(private readonly registry: RegionRegistryService) {}

  @Get()
  @AnyStaff()
  get(@CurrentStaff() staff: PosPrincipal): Promise<TenantSummary> {
    return this.registry.planeFor(this.registry.homeRegion()).$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      return readTenantSummary(tx, staff.tenantId)
    })
  }
}
