import { Controller, Get, Param } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { AttendanceView } from './attendance.dtos'
import { AttendanceService } from './attendance.service'

@Controller('pos/v1')
export class PosAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('outlets/:outletId/attendance')
  getAttendance(@CurrentStaff() staff: PosPrincipal, @Param('outletId') outletId: string): Promise<AttendanceView> {
    return this.attendance.getAttendance(staff, outletId)
  }
}
