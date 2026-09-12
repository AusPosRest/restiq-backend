import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { PosDevicesService } from './devices.service'

@Controller('pos/v1')
export class PosDevicesController {
  constructor(private readonly devices: PosDevicesService) {}

  // Issue #134: POS / printer / terminal tabs call this every 30 s.
  @Post('devices/:id/heartbeat')
  @HttpCode(204)
  async heartbeat(@CurrentStaff() staff: PosPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.devices.heartbeat(staff, id)
  }
}
