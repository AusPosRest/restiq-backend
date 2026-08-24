// AD-10: the /admin/* prefix accepts only aud:"admin" tokens signed with the
// admin secret - the third disjoint realm, same pattern as the ops guard
// (AD-3). Applied globally so every future /admin controller is covered
// without opting in; non-/admin routes pass through untouched.
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AdminPrincipal, verifyAdminToken } from './admin-jwt'
import { IS_PUBLIC } from './ops-auth.guard'

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
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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
    request.owner = principal
    return true
  }
}
