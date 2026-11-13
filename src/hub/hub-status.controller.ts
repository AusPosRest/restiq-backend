// Hub mode (#307, HUB-BUILD-PLAN H6): what the till's offline pill and Sync
// issues screen read. Status is for any signed-in staff; the rejections list
// and acknowledge need settle_bills (D-7) - the web shows the Sync issues
// link only when the list answers 200. Hub-only: the cloud has no such routes.
import { Controller, Get, HttpCode, Logger, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import { AnyStaff, RequirePermission } from '../platform'
import { HubContext, lockState } from './lock.guard'
import { outboxDepth } from './outbox'

interface RejectionItem {
  opId: string
  type: string
  code: string
  message: string
  at: string
  source: 'cloud' | 'orphan'
}

@Controller('pos/v1/hub')
export class HubStatusController {
  private readonly logger = new Logger('HubStatus')

  constructor(private readonly hub: HubContext) {}

  @Get('status')
  @AnyStaff()
  async status() {
    const { pg } = this.hub
    const { meta, mustSyncBefore, lockReason } = await lockState(pg, this.hub.now())
    return {
      online: meta?.online ?? false,
      lastSyncAt: meta?.lastSyncAt ?? null,
      outboxDepth: await outboxDepth(pg),
      mustSyncBefore,
      locked: lockReason !== null,
      lockReason,
      rejections: (await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM hub_rejections WHERE NOT acknowledged')).rows[0].n,
      orphans: await this.orphans(),
    }
  }

  @Get('rejections')
  @RequirePermission('settle_bills')
  async rejections(): Promise<{ items: RejectionItem[] }> {
    const { rows } = await this.hub.pg.query<RejectionItem>(
      `SELECT "opId", type, code, message, to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, source FROM (
         SELECT op_id AS "opId", type, code, message, at, 'cloud' AS source FROM hub_rejections WHERE NOT acknowledged
         UNION ALL
         SELECT id, entity, 'orphan', '', created_at, 'orphan' FROM hub_orphans WHERE NOT acknowledged
       ) r ORDER BY r.at`,
    )
    return { items: rows.map((row) => (row.source === 'orphan' ? { ...row, message: orphanMessage(row.type) } : row)) }
  }

  /** Marked here at once; forwarded to the cloud now when online, else by the sync worker's next tick. */
  @Post('rejections/:opId/acknowledge')
  @RequirePermission('settle_bills')
  @HttpCode(204)
  async acknowledge(@Param('opId', ParseUUIDPipe) opId: string): Promise<void> {
    const { affectedRows } = await this.hub.pg.query(
      'UPDATE hub_rejections SET ack_pending = ack_pending OR NOT acknowledged, acknowledged = true WHERE op_id = $1',
      [opId],
    )
    if (!affectedRows) {
      // #306: an orphan is the hub's own - acknowledged here only, never sent to the cloud.
      const orphan = await this.hub.pg.query('UPDATE hub_orphans SET acknowledged = true WHERE id = $1', [opId])
      if (!orphan.affectedRows) throw new NotFoundException({ code: 'not_found', message: 'No such sync issue' })
      return
    }
    const worker = this.hub.worker()
    if (worker?.online) await worker.forwardAcks().catch((error: unknown) => this.logger.warn(`acknowledge queued, cloud call failed: ${String(error)}`))
  }

  private async orphans(): Promise<number> {
    return (await this.hub.pg.query<{ n: number }>('SELECT count(*)::int AS n FROM hub_orphans WHERE NOT acknowledged')).rows[0].n
  }
}

const ORPHAN_LABEL: Record<string, string> = { order: 'An order', order_line: 'An order line', bill: 'A bill', bill_finalized: 'A bill payment' }

/** What staff read for a #306 orphan: a sale the till saved but never recorded for the cloud. */
function orphanMessage(entity: string): string {
  return `${ORPHAN_LABEL[entity] ?? 'A sale'} was saved on this till during a power cut but never sent to the cloud. Check it, and enter it again if it should count.`
}
