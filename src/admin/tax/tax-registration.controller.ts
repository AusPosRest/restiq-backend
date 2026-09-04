import { Body, Controller, Get, Put } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { TaxRegistrationView, UpdateTaxRegistrationDto } from './tax-registration.dtos'
import { TaxRegistrationService } from './tax-registration.service'

@Controller('admin/v1/tax-registration')
export class AdminTaxController {
  constructor(private readonly tax: TaxRegistrationService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal): Promise<TaxRegistrationView> {
    return this.tax.get(owner)
  }

  @Put()
  update(@CurrentOwner() owner: AdminPrincipal, @Body() dto: UpdateTaxRegistrationDto): Promise<TaxRegistrationView> {
    return this.tax.update(owner, dto)
  }
}
