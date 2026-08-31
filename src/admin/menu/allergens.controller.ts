import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { AllergenView, CreateAllergenDto } from './allergens.dtos'
import { AllergensService } from './allergens.service'

@Controller('admin/v1/menu/allergens')
export class AdminMenuAllergensController {
  constructor(private readonly allergens: AllergensService) {}

  @Get()
  list(@CurrentOwner() owner: AdminPrincipal): Promise<AllergenView[]> {
    return this.allergens.list(owner)
  }

  @Post()
  @HttpCode(201)
  create(@CurrentOwner() owner: AdminPrincipal, @Body() dto: CreateAllergenDto): Promise<AllergenView> {
    return this.allergens.create(owner, dto)
  }
}
