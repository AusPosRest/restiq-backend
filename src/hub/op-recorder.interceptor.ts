// Hub mode (#300, HUB-BUILD-PLAN H3): every hub write becomes a sync op before
// the till hears it worked. One mutex serialises all non-GET requests:
// handler -> build the op (op-map.ts) -> journal append + fsync -> outbox row
// -> reply. A power cut between the handler's commit and the fsync leaves a
// row with no op whose reply was never sent; H5 reconciles those orphans.
import { CallHandler, ConflictException, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common'
import type { PGlite } from '@electric-sql/pglite'
import type { Request } from 'express'
import { from, lastValueFrom, Observable } from 'rxjs'
import { uuidv7, type PosPrincipal } from '../platform'
import { appendOp } from './journal'
import { mappingFor, type OpInput } from './op-map'
import { insertOp, nextSeq, type HubOp } from './outbox'

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

@Injectable()
export class OpRecorderInterceptor implements NestInterceptor {
  private readonly logger = new Logger('OpRecorder')
  // ponytail: one global write lock - the hub has one till's worth of writers; per-order locks if that ever queues.
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly pg: PGlite,
    private readonly dataDir: string,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { staff?: PosPrincipal }>()
    if (READS.has(req.method)) return next.handle()
    const run = this.tail.then(() => this.write(req, next))
    this.tail = run.catch(() => undefined)
    return from(run)
  }

  private async write(req: Request & { staff?: PosPrincipal }, next: CallHandler): Promise<unknown> {
    const mapping = mappingFor(req.method, (req.route as { path: string }).path)
    if (mapping === undefined || mapping === 'unsupported') {
      throw new ConflictException({ code: 'offline_unsupported', message: 'This is not available while the till works offline' })
    }
    const startedAt = new Date()
    const result: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined })
    if (mapping === 'local') return result

    const input: OpInput = { body: req.body, params: req.params as Record<string, string>, result, staff: req.staff, startedAt, query: (sql, params) => this.query(sql, params) }
    let built
    try {
      built = await mapping(input)
    } catch (error) {
      // The write is committed but has no op: the cloud will never see it. op-recorder.spec covers every route so this can't happen in normal use.
      this.logger.error(`NO SYNC OP for ${req.method} ${req.path} - the write is on the hub only: ${String(error)}`)
      return result
    }
    if (!built) return result

    const op: HubOp = { opId: uuidv7(), seq: await nextSeq(this.pg), at: startedAt.toISOString(), ...built }
    appendOp(this.dataDir, op)
    await insertOp(this.pg, op)
    return result
  }

  private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE') // PGlite's superuser for this read only, past RLS
      return (await tx.query<T>(sql, params)).rows
    })
  }
}
