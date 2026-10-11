// restiq-backend#213: the owner's own tenant - its name and whether it is in Test mode - for the console header.
import { Controller, Get } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner, readTenantSummary, RegionRegistryService, TenantSummary } from '../platform'
import { setTenantContext } from './menu/tenant-context'

@Controller('admin/v1/tenant')
export class AdminTenantController {
  constructor(private readonly registry: RegionRegistryService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal): Promise<TenantSummary> {
    return this.registry.planeFor(this.registry.homeRegion()).$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      return readTenantSummary(tx, owner.tenantId)
    })
  }
}
