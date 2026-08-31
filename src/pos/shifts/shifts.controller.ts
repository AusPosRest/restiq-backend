import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import { CurrentStaff, PosPrincipal } from '../../platform'
import { CloseShiftDto, LogCashMovementDto, OpenShiftDto } from './shifts.dtos'
import { ShiftsService, ShiftView } from './shifts.service'

@Controller('pos/v1/shifts')
export class PosShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post()
  @HttpCode(201)
  open(@CurrentStaff() staff: PosPrincipal, @Body() dto: OpenShiftDto): Promise<ShiftView> {
    return this.shifts.openShift(staff, dto)
  }

  // Lets a reloaded/rejoined session find the outlet's open shift without
  // already knowing its id.
  @Get('current')
  getCurrent(@CurrentStaff() staff: PosPrincipal, @Query('outletId') outletId: string): Promise<ShiftView> {
    return this.shifts.getCurrentShift(staff, outletId)
  }

  @Get(':id')
  getOne(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string): Promise<ShiftView> {
    return this.shifts.getShift(staff, id)
  }

  @Post(':id/cash-movements')
  @HttpCode(201)
  logCashMovement(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string, @Body() dto: LogCashMovementDto): Promise<ShiftView> {
    return this.shifts.logCashMovement(staff, id, dto)
  }

  // CAP-10 blind close: countedMinor is the only input this endpoint takes.
  // expectedMinor/overShortMinor come back in the response because they were
  // just computed and stored, in this same call - there is no earlier
  // endpoint a client could have called to see them first.
  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentStaff() staff: PosPrincipal, @Param('id') id: string, @Body() dto: CloseShiftDto): Promise<ShiftView> {
    return this.shifts.closeShift(staff, id, dto)
  }
}
