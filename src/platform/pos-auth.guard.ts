// AD-13: the /pos/* prefix accepts only aud:"pos" tokens signed with the pos
// secret - the fourth disjoint realm, same pattern as the ops/admin guards
// (AD-3/AD-10). Applied globally so every future /pos controller is covered
// without opting in; non-/pos routes pass through untouched. Note a
// `pos-pending` token (mid outlet-selection) is a different audience and is
// never accepted here - only login/select-outlet ever see it, both @Public().
//
// kitchen-display/CAP-1 (AD-16, issue #67): /kitchen/* rides this exact same
// realm - "auth realms separate principal types, not screens" - so the match
// below is extended to cover it rather than mounting kitchen routes under
// /pos/v1 or standing up a second guard for the same principal type.
//
// restiq-backend#169: a valid signature is not enough. Every request re-reads
// the staff row: a revoked PIN or a sessionVersion that moved on (PIN
// reissued/revoked, role changed, logout) ends the session at once instead of
// after the token's 12 hours. The role comes from that row, and the handler's
// @RequirePermission / @AnyStaff policy is checked against it - a handler with
// no policy is refused (fail closed).
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { IS_PUBLIC } from './ops-auth.guard'
import { ROUTE_PERMISSION, RoutePolicy, roleHasPermission } from './permissions'
import { PosPrincipal, verifyPosToken } from './pos-jwt'
import { RegionRegistryService } from './region-registry.service'
import { TenantAddressService } from './tenant-address.service'
import { isTenantBlocked } from './tenant-lifecycle'

type PosRequest = Request & { staff?: PosPrincipal }
type Tx = Parameters<Parameters<ReturnType<RegionRegistryService['planeFor']>['$transaction']>[0]>[0]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// restiq-backend#209 (SE-26): every outlet a request reaches - named in the URL/body/query, or owning the
// order/bill/shift/ticket/... it names - so staff restricted to some outlets are held to them on every
// call, not only at sign-in. Unknown ids are skipped; the handler answers those with its own 404.
async function outletsReached(tx: Tx, request: Request): Promise<string[]> {
  const params = request.params as Record<string, string | undefined>
  const body: unknown = request.body
  const named = [params.outletId, typeof request.query.outletId === 'string' ? request.query.outletId : undefined]
  if (typeof body === 'object' && body !== null && typeof (body as { outletId?: unknown }).outletId === 'string') named.push((body as { outletId: string }).outletId)

  const route = (request.route as { path?: string } | undefined)?.path ?? ''
  const id = params.id && UUID.test(params.id) ? params.id : undefined
  const lookups: Promise<{ outletId: string } | null>[] = []
  const select = { outletId: true } as const
  if (params.orderId && UUID.test(params.orderId)) lookups.push(tx.order.findUnique({ where: { id: params.orderId }, select }))
  if (params.ticketId && UUID.test(params.ticketId)) lookups.push(tx.ticket.findUnique({ where: { id: params.ticketId }, select }))
  if (id && route.includes('/bills/:id')) lookups.push(tx.bill.findUnique({ where: { id }, select }))
  if (id && route.includes('/shifts/:id')) lookups.push(tx.shift.findUnique({ where: { id }, select }))
  if (id && route.includes('/payment-intents/:id')) lookups.push(tx.paymentIntent.findUnique({ where: { id }, select }))
  if (id && route.includes('/print-jobs/:id')) lookups.push(tx.printJob.findUnique({ where: { id }, select }))
  const owned = (await Promise.all(lookups)).map((row) => row?.outletId)
  return [...named, ...owned].filter((outletId): outletId is string => typeof outletId === 'string')
}

/** Injects the guard-verified pos staff session into a handler parameter. */
export const CurrentStaff = createParamDecorator((_data: unknown, context: ExecutionContext): PosPrincipal => {
  const { staff } = context.switchToHttp().getRequest<PosRequest>()
  if (!staff) {
    // Only reachable if a handler forgets the guard chain - fail closed.
    throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid POS session is required' })
  }
  return staff
})

@Injectable()
export class PosAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly registry: RegionRegistryService,
    private readonly address: TenantAddressService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PosRequest>()
    if (!/^\/(pos|kitchen)(\/|$)/.test(request.path)) return true

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])
    if (isPublic) return true

    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const claims = token ? verifyPosToken(token) : null
    if (!claims) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid POS session is required' })
    }
    if (await isTenantBlocked(this.registry, claims.tenantId)) {
      throw new ForbiddenException({ code: 'tenant_inactive', message: 'This tenant is no longer active' })
    }
    await this.address.assertTokenMatchesAddress(request, claims.tenantId)

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const { staff, deviceActive, outsideOutlets } = await plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${claims.tenantId}, true)`
      const staffRow = await tx.staffUser.findUnique({
        where: { id: claims.id },
        select: { tenantId: true, name: true, pinRevokedAt: true, sessionVersion: true, outletIds: true, role: { select: { name: true } } },
      })
      // restiq-backend#209 (SE-11): a session signed in on an enrolled till ends when that till is revoked.
      const active = claims.deviceId === undefined || (await tx.device.count({ where: { id: claims.deviceId, tenantId: claims.tenantId, status: 'active', revokedAt: null } })) > 0
      // Empty outletIds = works at every outlet (#197), so only restricted staff need the lookups.
      const allowed = staffRow?.outletIds ?? []
      const outside = allowed.length > 0 ? (await outletsReached(tx, request)).some((outletId) => !allowed.includes(outletId)) : false
      return { staff: staffRow, deviceActive: active, outsideOutlets: outside }
    })
    if (!staff || staff.tenantId !== claims.tenantId || staff.pinRevokedAt || staff.sessionVersion !== claims.sessionVersion) {
      throw new UnauthorizedException({ code: 'session_revoked', message: 'This session has ended - log in again' })
    }
    if (!deviceActive) {
      throw new UnauthorizedException({ code: 'device_revoked', message: 'This device was removed by the owner - set it up again with a new code' })
    }
    if (outsideOutlets) {
      throw new ForbiddenException({ code: 'outlet_mismatch', message: `${staff.name} isn't set up to work at this outlet` })
    }

    const policy = this.reflector.getAllAndOverride<RoutePolicy | undefined>(ROUTE_PERMISSION, [context.getHandler(), context.getClass()])
    if (!policy) {
      throw new ForbiddenException({ code: 'forbidden', message: 'This action has no permission policy' })
    }
    if (policy !== 'any_staff' && !roleHasPermission(staff.role.name, policy)) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Your role cannot do this' })
    }

    request.staff = { id: claims.id, tenantId: claims.tenantId, outletId: claims.outletId, name: staff.name, role: staff.role.name }
    return true
  }
}
