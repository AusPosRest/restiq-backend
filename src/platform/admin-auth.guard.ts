// AD-10: the /admin/* prefix accepts only aud:"admin" tokens signed with the
// admin secret - the third disjoint realm, same pattern as the ops guard
// (AD-3). Applied globally so every future /admin controller is covered
// without opting in; non-/admin routes pass through untouched.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AdminPrincipal, verifyAdminToken } from './admin-jwt'
import { IS_PUBLIC } from './ops-auth.guard'
import { RegionRegistryService } from './region-registry.service'
import { isTenantBlocked } from './tenant-lifecycle'

type AdminRequest = Request & { owner?: AdminPrincipal }

/** Injects the guard-verified tenant owner into a handler parameter. */
export const CurrentOwner = createParamDecorator((_data: unknown, context: ExecutionContext): AdminPrincipal => {
  const { owner } = context.switchToHttp().getRequest<AdminRequest>()
  if (!owner) {
    // Only reachable if a handler forgets the guard chain - fail closed.
    throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid owner session is required' })
  }
  return owner
})

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly registry: RegionRegistryService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>()
    if (!/^\/admin(\/|$)/.test(request.path)) return true

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])
    if (isPublic) return true

    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const principal = token ? verifyAdminToken(token) : null
    if (!principal) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid owner session is required' })
    }
    if (await isTenantBlocked(this.registry, principal.tenantId)) {
      throw new ForbiddenException({ code: 'tenant_inactive', message: 'This tenant is no longer active' })
    }
    // A token that carries a session version must still match the owner's: a password reset ends every older session.
    if (principal.sessionVersion !== undefined) {
      const plane = this.registry.planeFor(this.registry.homeRegion())
      const owner = await plane.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${principal.tenantId}, true)`
        return tx.ownerUser.findUnique({ where: { id: principal.id }, select: { tenantId: true, sessionVersion: true } })
      })
      if (!owner || owner.tenantId !== principal.tenantId || owner.sessionVersion !== principal.sessionVersion) {
        throw new UnauthorizedException({ code: 'session_revoked', message: 'This session has ended - sign in again' })
      }
    }
    request.owner = principal
    return true
  }
}
