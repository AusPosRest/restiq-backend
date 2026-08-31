// CAP-6 devices & printers: a thin tenant-scoped wrapper around the ops
// realm's DevicesService (AD-12 - one enrolment implementation, two
// callers). This module adds no device/enrolment-code logic of its own -
// it forces tenantId to the signed-in owner's own tenant (never trusting a
// client-supplied value, unlike the ops DTO) and delegates the rest.
import { Injectable, NotFoundException } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { DeviceListResult, DevicesService } from '../../ops'
import { setTenantContext } from '../menu/tenant-context'
import { AdminGenerateCodeDto } from './devices.dtos'

@Injectable()
export class AdminDevicesService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly devices: DevicesService,
  ) {}

  private async assertOutlet(tenantId: string, outletId: string): Promise<void> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, tenantId)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
      }
    })
  }

  async list(owner: AdminPrincipal, outletId: string): Promise<DeviceListResult> {
    await this.assertOutlet(owner.tenantId, outletId)
    // Same Prisma query DevicesService.list() runs for Platform Console's
    // fleet/tenant views, scoped one level further to this outlet.
    return this.devices.list({ tenantId: owner.tenantId, outletId })
  }

  async generateCode(owner: AdminPrincipal, outletId: string, dto: AdminGenerateCodeDto): Promise<{ code: string; deviceType: string; expiresAt: string }> {
    // The shared service itself 404s if outletId doesn't belong to tenantId
    // (see devices.service.ts generateCode) - that check, not a second one
    // here, is what proves the cross-tenant isolation test for this route.
    return this.devices.generateCode(owner, { tenantId: owner.tenantId, outletId, deviceType: dto.deviceType, reason: dto.reason })
  }
}
