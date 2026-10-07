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
import { isTenantBlocked } from './tenant-lifecycle'

type PosRequest = Request & { staff?: PosPrincipal }

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

    const plane = this.registry.planeFor(this.registry.homeRegion())
    const staff = await plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${claims.tenantId}, true)`
      return tx.staffUser.findUnique({
        where: { id: claims.id },
        select: { tenantId: true, name: true, pinRevokedAt: true, sessionVersion: true, role: { select: { name: true } } },
      })
    })
    if (!staff || staff.tenantId !== claims.tenantId || staff.pinRevokedAt || staff.sessionVersion !== claims.sessionVersion) {
      throw new UnauthorizedException({ code: 'session_revoked', message: 'This session has ended - log in again' })
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
