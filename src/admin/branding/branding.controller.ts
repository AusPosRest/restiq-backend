import { Body, Controller, Get, Put } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { BrandingService } from './branding.service'
import { BrandingView, UpdateBrandingDto } from './branding.dtos'

@Controller('admin/v1/branding')
export class AdminBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal): Promise<BrandingView> {
    return this.branding.get(owner)
  }

  @Put()
  update(@CurrentOwner() owner: AdminPrincipal, @Body() dto: UpdateBrandingDto): Promise<BrandingView> {
    return this.branding.update(owner, dto)
  }
}
