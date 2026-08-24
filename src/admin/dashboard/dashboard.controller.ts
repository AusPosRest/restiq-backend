import { Controller, Get } from '@nestjs/common'
import { AdminPrincipal, CurrentOwner } from '../../platform'
import { DashboardService, DashboardView } from './dashboard.service'

@Controller('admin/v1/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(@CurrentOwner() owner: AdminPrincipal): Promise<DashboardView> {
    return this.dashboard.get(owner)
  }
}
