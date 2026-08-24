import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { ChecklistService, ChecklistView, GoLiveResult } from './checklist.service'
import { UpdateChecklistStepDto } from './checklist.dtos'

@Controller('admin/v1/checklist')
export class AdminChecklistController {
  constructor(private readonly checklist: ChecklistService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal): Promise<ChecklistView> {
    return this.checklist.getChecklist(owner.tenantId)
  }

  @Patch(':step')
  updateStep(
    @CurrentOwner() owner: AdminPrincipal,
    @Param('step') step: string,
    @Body() dto: UpdateChecklistStepDto,
  ): Promise<ChecklistView> {
    return this.checklist.updateStep(owner.tenantId, step, dto.completed)
  }

  @Post('go-live')
  goLive(@CurrentOwner() owner: AdminPrincipal): Promise<GoLiveResult> {
    return this.checklist.goLive(owner)
  }
}
