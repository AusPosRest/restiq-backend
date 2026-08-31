import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { CreateStaffDto, RevokePinDto, UpdateStaffDto } from './staff.dtos'
import { StaffListResult, StaffService, StaffView } from './staff.service'

@Controller('admin/v1/staff')
export class AdminStaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<StaffListResult> {
    return this.staff.list(owner)
  }

  @Post()
  @HttpCode(201)
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: CreateStaffDto): Promise<StaffView> {
    return this.staff.create(owner, dto)
  }

  @Patch(':id')
  update(@CurrentOwner() owner: AdminPrincipal, @Param('id') id: string, @Body() dto: UpdateStaffDto): Promise<StaffView> {
    return this.staff.update(owner, id, dto)
  }

  @Post(':id/pin')
  @HttpCode(201)
  issuePin(@CurrentOwner() owner: AdminPrincipal, @Param('id') id: string): Promise<{ pin: string }> {
    return this.staff.issuePin(owner, id)
  }

  @Post(':id/revoke-pin')
  @HttpCode(200)
  revokePin(@CurrentOwner() owner: AdminPrincipal, @Param('id') id: string, @Body() dto: RevokePinDto): Promise<StaffView> {
    return this.staff.revokePin(owner, id, dto.reason)
  }
}
