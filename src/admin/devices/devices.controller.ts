import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { DeviceListResult } from '../../ops'
import { AdminGenerateCodeDto } from './devices.dtos'
import { AdminDevicesService } from './devices.service'

@Controller('admin/v1/outlets/:outletId/devices')
export class AdminDevicesController {
  constructor(private readonly devices: AdminDevicesService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal, @Param('outletId') outletId: string): Promise<DeviceListResult> {
    return this.devices.list(owner, outletId)
  }

  @Post('enrolment-codes')
  @HttpCode(201)
  generateCode(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('outletId') outletId: string,
    @Body() dto: AdminGenerateCodeDto,
  ): Promise<{ code: string; deviceType: string; expiresAt: string }> {
    return this.devices.generateCode(owner, outletId, dto)
  }
}
