// restiq-backend#213: the owner's own tenant - its name and whether it is in Test mode - for the console header.
import { Controller, Get } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner, readTenantSummary, RegionRegistryService, TenantSummary } from '../platform'
import { setTenantContext } from './menu/tenant-context'

@Controller('admin/v1/tenant')
export class AdminTenantController {
  constructor(private readonly registry: RegionRegistryService) {}

  // #314: `service` tells the console it is an operator in service mode (null for the owner).
  @Get()
  async get(@CurrentOwner() owner: AdminPrincipal): Promise<TenantSummary & { service: { operatorEmail: string; expiresAt: string } | null }> {
    const summary = await this.registry.planeFor(this.registry.homeRegion()).$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      return readTenantSummary(tx, owner.tenantId)
    })
    const service = owner.service && owner.expiresAt !== undefined ? { operatorEmail: owner.email, expiresAt: new Date(owner.expiresAt * 1000).toISOString() } : null
    return { ...summary, service }
  }
}
