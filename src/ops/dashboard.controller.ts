// Dashboard KPI tiles (O2). One key per request so each tile loads, fails and
// retries independently in the console.
import { Controller, Get, Param } from '@nestjs/common'
import { TenantDirectoryService } from './tenants/directory.service'

@Controller('ops/v1/dashboard')
export class OpsDashboardController {
  constructor(private readonly directory: TenantDirectoryService) {}

  @Get('kpis/:key')
  kpi(@Param('key') key: string): Promise<{ key: string; value: number }> {
    return this.directory.kpi(key)
  }
}
