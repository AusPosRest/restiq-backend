// POS-realm heartbeat (issue #134): the web POS, printer and card-terminal
// tabs report they are alive, so the owner's topology can show which devices
// are on. Same metadata-only snapshot as the ops heartbeat (NFR-15), scoped
// to the signed-in staff member's own tenant and outlet.
import { Injectable, NotFoundException } from '@nestjs/common'
import { PosPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../tenant-context'

@Injectable()
export class PosDevicesService {
  constructor(private readonly registry: RegionRegistryService) {}

  async heartbeat(staff: PosPrincipal, deviceId: string): Promise<void> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const { count } = await tx.device.updateMany({
        where: { id: deviceId, tenantId: staff.tenantId, outletId: staff.outletId, status: 'active' },
        data: { lastContactAt: new Date() },
      })
      if (count === 0) throw new NotFoundException({ code: 'not_found', message: 'No such active device at this outlet' })
    })
  }
}
