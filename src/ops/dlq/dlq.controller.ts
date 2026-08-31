import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common'
import { CurrentOperator, OpsPrincipal } from '../../platform'
import { BulkReplayDto, ReplayDto } from './dlq.dtos'
import { DeadLetterListResult, DlqService, ReplayResult } from './dlq.service'

@Controller('ops/v1/dead-letters')
export class OpsDlqController {
  constructor(private readonly dlq: DlqService) {}

  // Fleet-wide by default; ?tenantId=/?deviceId=/?reasonCode= filter it (the
  // same params a pre-filtered cross-link, e.g. from Sync Health, would send).
  @Get()
  list(@Query() query: Record<string, string | undefined>): Promise<DeadLetterListResult> {
    return this.dlq.list(query)
  }

  @Post(':id/replay')
  @HttpCode(200)
  replay(
    @CurrentOperator() operator: OpsPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplayDto,
  ): Promise<ReplayResult> {
    return this.dlq.replay(operator, id, dto.reason)
  }

  @Post('replay-bulk')
  @HttpCode(200)
  replayBulk(@CurrentOperator() operator: OpsPrincipal, @Body() dto: BulkReplayDto): Promise<{ results: ReplayResult[] }> {
    return this.dlq.replayBulk(operator, dto)
  }
}
