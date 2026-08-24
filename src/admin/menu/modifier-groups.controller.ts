import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { CreateModifierDto, CreateModifierGroupDto, ModifierGroupView, UpdateModifierGroupDto } from './modifier-groups.dtos'
import { ModifierGroupsService } from './modifier-groups.service'

@Controller('admin/v1/menu/modifier-groups')
export class AdminMenuModifierGroupsController {
  constructor(private readonly groups: ModifierGroupsService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<ModifierGroupView[]> {
    return this.groups.list(owner)
  }

  @Post()
  @HttpCode(201)
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: CreateModifierGroupDto): Promise<ModifierGroupView> {
    return this.groups.create(owner, dto)
  }

  @Patch(':groupId')
  update(@CurrentOwner() owner: AdminPrincipal, @Param('groupId') groupId: string, @Body() dto: UpdateModifierGroupDto): Promise<ModifierGroupView> {
    return this.groups.update(owner, groupId, dto)
  }

  @Post(':groupId/modifiers')
  @HttpCode(201)
  addModifier(@CurrentOwner() owner: AdminPrincipal, @Param('groupId') groupId: string, @Body() dto: CreateModifierDto): Promise<ModifierGroupView> {
    return this.groups.addModifier(owner, groupId, dto)
  }
}
