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
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { IS_PUBLIC } from './ops-auth.guard'
import { PosPrincipal, verifyPosToken } from './pos-jwt'

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
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<PosRequest>()
    if (!/^\/(pos|kitchen)(\/|$)/.test(request.path)) return true

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])
    if (isPublic) return true

    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const principal = token ? verifyPosToken(token) : null
    if (!principal) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid POS session is required' })
    }
    request.staff = principal
    return true
  }
}
