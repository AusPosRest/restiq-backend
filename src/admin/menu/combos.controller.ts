import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { ComboView, SaveComboDto } from './combos.dtos'
import { CombosService } from './combos.service'

@Controller('admin/v1/menu/combos')
export class AdminMenuCombosController {
  constructor(private readonly combos: CombosService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<ComboView[]> {
    return this.combos.list(owner)
  }

  @Post()
  @HttpCode(201)
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: SaveComboDto): Promise<ComboView> {
    return this.combos.create(owner, dto)
  }

  @Put(':comboId')
  update(@CurrentOwner() owner: AdminPrincipal, @Param('comboId', ParseUUIDPipe) comboId: string, @Body() dto: SaveComboDto): Promise<ComboView> {
    return this.combos.update(owner, comboId, dto)
  }

  @Delete(':comboId')
  @HttpCode(204)
  archive(@CurrentOwner() owner: AdminPrincipal, @Param('comboId', ParseUUIDPipe) comboId: string): Promise<void> {
    return this.combos.archive(owner, comboId)
  }
}
