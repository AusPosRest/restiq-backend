// AD-3: the /ops/* prefix accepts only aud:"ops" tokens signed with the ops
// secret. Applied globally (APP_GUARD) so every future /ops controller is
// covered without opting in; non-/ops routes pass through untouched (tenant
// guards arrive with the tenant realm).
import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { OpsPrincipal, verifyOpsToken } from './ops-jwt'
import { PrismaService } from './prisma.service'

// Exported so the admin guard (AD-10) can share the same @Public() marker -
// one realm-agnostic "no session required" flag, not two.
export const IS_PUBLIC = 'isPublic'

/** Marks a route reachable without a session (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true)

type OpsRequest = Request & { operator?: OpsPrincipal }

/** Injects the guard-verified operator into a handler parameter. */
export const CurrentOperator = createParamDecorator((_data: unknown, context: ExecutionContext): OpsPrincipal => {
  const { operator } = context.switchToHttp().getRequest<OpsRequest>()
  if (!operator) {
    // Only reachable if a handler forgets the guard chain - fail closed.
    throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid operator session is required' })
  }
  return operator
})

@Injectable()
export class OpsAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OpsRequest>()
    if (!/^\/ops(\/|$)/.test(request.path)) return true

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])
    if (isPublic) return true

    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const principal = token ? verifyOpsToken(token) : null
    if (!principal) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid operator session is required' })
    }
    // A token that carries a session version must still match the operator's: a logout ends every older session.
    if (principal.sessionVersion !== undefined) {
      const operator = await this.prisma.client.operatorUser.findUnique({ where: { id: principal.id }, select: { sessionVersion: true } })
      if (!operator || operator.sessionVersion !== principal.sessionVersion) {
        throw new UnauthorizedException({ code: 'session_revoked', message: 'This session has ended - sign in again' })
      }
    }
    request.operator = principal
    return true
  }
}
