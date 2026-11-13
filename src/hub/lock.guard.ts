// Hub mode (#307, HUB-BUILD-PLAN H6): the O1 offline lock (SYNC-DESIGN §9).
// Once the hub has gone policy.maxOfflineHours without a successful sync, new
// sales stop (order create, counter order, line add, combo add) with 423
// offline_locked; closing and finalizing open bills, printing and reads carry
// on (D-8). A revoked device refuses every write. Runs after PosAuthGuard
// (installed with useGlobalGuards, after the APP_GUARDs), so an anonymous
// caller still gets 401, not the lock.
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common'
import type { PGlite } from '@electric-sql/pglite'
import type { Request } from 'express'
import { readMeta, type HubMeta } from './meta'
import { routeKey } from './op-map'
import type { SyncWorker } from './sync-worker'

/** What the hub's own controllers and guard share: the store, the clock (faked in tests) and the sync worker once it runs. */
export class HubContext {
  constructor(
    readonly pg: PGlite,
    readonly now: () => Date = () => new Date(),
    readonly worker: () => SyncWorker | undefined = () => undefined,
  ) {}
}

export type LockReason = 'offline_limit' | 'revoked'

export interface LockState {
  meta: HubMeta | undefined
  mustSyncBefore: Date | null
  lockReason: LockReason | null
}

/** Before the first bootstrap there is nothing to lock against. */
export async function lockState(pg: Pick<PGlite, 'query'>, now: Date): Promise<LockState> {
  const meta = await readMeta(pg)
  const mustSyncBefore = meta?.lastSyncAt ? new Date(meta.lastSyncAt.getTime() + meta.policy.maxOfflineHours * 3_600_000) : null
  const lockReason = meta?.lockReason === 'revoked' ? 'revoked' : mustSyncBefore && now > mustSyncBefore ? 'offline_limit' : null
  return { meta, mustSyncBefore, lockReason }
}

const NEW_SALES = new Set(
  ['POST /pos/v1/outlets/:o/tables/:t/order', 'POST /pos/v1/outlets/:o/counter-orders', 'POST /pos/v1/orders/:id/lines', 'POST /pos/v1/orders/:id/combos'].map(
    (route) => routeKey(...(route.split(' ') as [string, string])),
  ),
)
const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

@Injectable()
export class HubLockGuard implements CanActivate {
  constructor(private readonly hub: HubContext) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()
    // Signing out (and a login, which fails anyway once revocation cleared the PINs) stays possible.
    if (READS.has(req.method) || req.path.startsWith('/pos/v1/auth/')) return true
    const { lockReason } = await lockState(this.hub.pg, this.hub.now())
    if (lockReason === 'revoked') {
      throw new HttpException({ code: 'device_revoked', message: 'This till has been removed from the restaurant. Contact your manager.' }, HttpStatus.LOCKED)
    }
    if (lockReason === 'offline_limit' && NEW_SALES.has(routeKey(req.method, (req.route as { path: string }).path))) {
      throw new HttpException(
        { code: 'offline_locked', message: 'This till has been offline too long to take new orders. You can still close and print open bills. Reconnect to the internet to unlock it.' },
        HttpStatus.LOCKED,
      )
    }
    return true
  }
}
