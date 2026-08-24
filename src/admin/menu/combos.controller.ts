import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { ComboView, CreateComboDto } from './combos.dtos'
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
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: CreateComboDto): Promise<ComboView> {
    return this.combos.create(owner, dto)
  }
}
