import { Controller, Get, Query } from '@nestjs/common'
import { SyncHealthResult, SyncHealthService } from './sync-health.service'

@Controller('ops/v1/sync-health')
export class OpsSyncHealthController {
  constructor(private readonly syncHealth: SyncHealthService) {}

  // Fleet-wide by default; ?tenantId= scopes it, ?severity= filters the rows
  // (the summary counts always reflect the unfiltered fleet).
  @Get()
  list(@Query() query: Record<string, string | undefined>): Promise<SyncHealthResult> {
    return this.syncHealth.list(query)
  }
}
