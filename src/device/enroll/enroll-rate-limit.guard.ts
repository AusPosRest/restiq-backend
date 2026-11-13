// Rate limit for the public, unauthenticated device enrolment endpoint (issue
// #95). Codes are short (3+3 chars over a 32-char alphabet, 15-min TTL) so
// brute force must be throttled.
//
// restiq-backend#209 (SE-32): keyed on the hardened client address the sign-in
// throttles use (resolveClientIp: the web proxy's X-Restiq-Client-Ip only with
// the shared secret, else req.ip through TRUST_PROXY_HOPS) - a raw
// X-Forwarded-For let a caller pick a fresh bucket per request - and counted in
// the shared auth_attempts table, so restarts and instances share one budget.
import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { AttemptLimiter, resolveClientIp } from '../../platform'

export const ENROLL_RATE_LIMIT_ATTEMPTS = 10
export const ENROLL_RATE_LIMIT_WINDOW_SECONDS = 5 * 60

@Injectable()
export class EnrollRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: AttemptLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ip = resolveClientIp(context.switchToHttp().getRequest<Request>())
    try {
      await this.limiter.consume([{ key: `device-enroll:ip:${ip}`, max: ENROLL_RATE_LIMIT_ATTEMPTS, windowSeconds: ENROLL_RATE_LIMIT_WINDOW_SECONDS }])
    } catch (error) {
      // Same answer clients already handle for this endpoint.
      if (error instanceof HttpException && error.getStatus() === 429) {
        throw new HttpException({ code: 'rate_limited', message: 'Too many enrolment attempts - try again later' }, 429)
      }
      throw error
    }
    return true
  }
}
