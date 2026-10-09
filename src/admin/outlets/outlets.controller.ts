import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { CapabilityView, OutletView, SetCapabilityDto, UpdateOutletDto } from './outlets.dtos'
import { OutletsService } from './outlets.service'
import type { StarterSetupResult } from './starter-setup'

@Controller('admin/v1/outlets')
export class AdminOutletsController {
  constructor(private readonly outlets: OutletsService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<OutletView[]> {
    return this.outlets.list(owner)
  }

  @Patch(':outletId')
  update(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string, @Body() dto: UpdateOutletDto): Promise<OutletView> {
    return this.outlets.update(owner, outletId, dto)
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

  // D2: the starting stations, tables and switches for this outlet's type. Idempotent.
  @Post(':outletId/starter-setup')
  @HttpCode(200)
  applyStarterSetup(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string): Promise<StarterSetupResult> {
    return this.outlets.applyStarterSetup(owner, outletId)
  }
}
