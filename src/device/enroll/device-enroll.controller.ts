import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { DeviceView } from '../../ops'
import { DeviceEnrollDto } from './device-enroll.dto'
import { DeviceEnrollService } from './device-enroll.service'

// Public by construction: no /device/* auth guard exists (unlike /ops,
// /admin, /pos, /guest - each of those guards early-returns true outside its
// own prefix, so none of them touch this route). The one-time enrolment code
// itself is the only credential a device presents.
@Controller('device/v1')
export class DeviceEnrollController {
  constructor(private readonly enrollService: DeviceEnrollService) {}

  @Post('enroll')
  @HttpCode(201)
  enroll(@Body() dto: DeviceEnrollDto): Promise<{ device: DeviceView }> {
    return this.enrollService.enroll(dto)
  }
}
