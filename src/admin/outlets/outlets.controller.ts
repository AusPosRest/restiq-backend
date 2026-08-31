import { Body, Controller, Get, Param, Patch } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { CapabilityView, OutletView, SetCapabilityDto } from './outlets.dtos'
import { OutletsService } from './outlets.service'

@Controller('admin/v1/outlets')
export class AdminOutletsController {
  constructor(private readonly outlets: OutletsService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<OutletView[]> {
    return this.outlets.list(owner)
  }

  @Get(':outletId/capabilities')
  listCapabilities(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string): Promise<CapabilityView[]> {
    return this.outlets.listCapabilities(owner, outletId)
  }

  @Patch(':outletId/capabilities/:key')
  setCapability(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('outletId') outletId: string,
    @Param('key') key: string,
    @Body() dto: SetCapabilityDto,
  ): Promise<CapabilityView> {
    return this.outlets.setCapability(owner, outletId, key, dto.enabled)
  }
}
