// Offline sync endpoints (restiq-backend#185). Guarded by DeviceSyncGuard (the
// /sync device realm, signed requests) - no staff token, no @RequirePermission:
// the device is the caller and each pushed op names its own staff member.
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, PayloadTooLargeException, Post, Query } from '@nestjs/common'
import { CurrentDevice, DevicePrincipal } from '../../platform'
import { SyncPushService } from './sync-push.service'
import { SYNC_BATCH_MAX, SyncOpResult, SyncPushDto } from './sync.dtos'
import { SyncService } from './sync.service'

@Controller('sync/v1')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly pushes: SyncPushService,
  ) {}

  @Get('bootstrap')
  bootstrap(@CurrentDevice() device: DevicePrincipal) {
    return this.sync.bootstrap(device)
  }

  @Get('pull')
  pull(@CurrentDevice() device: DevicePrincipal, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.sync.pull(device, cursor, limit)
  }

  @Post('push')
  @HttpCode(200)
  async push(@CurrentDevice() device: DevicePrincipal, @Body() dto: SyncPushDto): Promise<{ results: SyncOpResult[]; serverTime: string }> {
    if (dto.ops.length > SYNC_BATCH_MAX) {
      throw new PayloadTooLargeException({ code: 'batch_too_large', message: `Send at most ${SYNC_BATCH_MAX} operations` })
    }
    const results = await this.pushes.push(device, dto.batchId, dto.ops)
    return { results, serverTime: new Date().toISOString() }
  }

  @Get('session-status')
  sessionStatus(@CurrentDevice() device: DevicePrincipal) {
    return this.sync.sessionStatus(device)
  }

  @Get('rejections')
  rejections(@CurrentDevice() device: DevicePrincipal, @Query('since') since?: string, @Query('includeAcknowledged') includeAcknowledged?: string) {
    return this.sync.rejections(device, since, includeAcknowledged)
  }

  @Post('rejections/:opId/acknowledge')
  @HttpCode(204)
  async acknowledge(@CurrentDevice() device: DevicePrincipal, @Param('opId', ParseUUIDPipe) opId: string): Promise<void> {
    await this.sync.acknowledge(device, opId)
  }
}
