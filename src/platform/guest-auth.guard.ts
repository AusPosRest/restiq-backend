// AD-17: the /guest/* prefix accepts only aud:"guest" tokens signed with the
// guest secret - the fifth disjoint realm, same pattern as the ops/admin/pos
// guards (AD-3/AD-10/AD-13). Applied globally so every future /guest
// controller is covered without opting in; non-/guest routes pass through
// untouched. No code path may accept a guest token on any other realm's
// routes, or another realm's token here - each guard early-returns true
// outside its own prefix and rejects everything that isn't its own audience.
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { IS_PUBLIC } from './ops-auth.guard'
import { GuestPrincipal, verifyGuestToken } from './guest-jwt'

type GuestRequest = Request & { guest?: GuestPrincipal }

/** Injects the guard-verified guest session into a handler parameter. */
export const CurrentGuest = createParamDecorator((_data: unknown, context: ExecutionContext): GuestPrincipal => {
  const { guest } = context.switchToHttp().getRequest<GuestRequest>()
  if (!guest) {
    // Only reachable if a handler forgets the guard chain - fail closed.
    throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid guest session is required' })
  }
  return guest
})

@Injectable()
export class GuestAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<GuestRequest>()
    if (!/^\/guest(\/|$)/.test(request.path)) return true

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])
    if (isPublic) return true

    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const principal = token ? verifyGuestToken(token) : null
    if (!principal) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid guest session is required' })
    }
    request.guest = principal
    return true
  }
}
