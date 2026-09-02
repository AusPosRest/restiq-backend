// Single-process in-memory rate limiter for the public, unauthenticated
// device enrolment endpoint (issue #95). Codes are short (3+3 chars over a
// 32-char alphabet, 15-min TTL) so brute force must be throttled.
//
// ponytail: state lives in a process-local Map, so a multi-instance deploy
// gives each instance its own budget instead of a shared one. That's a
// deliberate prototype-scope limit, not an oversight - move to a shared
// store (Redis) if/when this API runs on more than one instance.
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common'
import type { Request } from 'express'

export const ENROLL_RATE_LIMIT_ATTEMPTS = 10
export const ENROLL_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000

interface Window {
  count: number
  windowStart: number
}

@Injectable()
export class EnrollRateLimitGuard implements CanActivate {
  private readonly attempts = new Map<string, Window>()

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    const ip = clientIp(request)
    const now = Date.now()

    const existing = this.attempts.get(ip)
    if (!existing || now - existing.windowStart >= ENROLL_RATE_LIMIT_WINDOW_MS) {
      // No entry, or its window has expired - evict/replace it here so the
      // Map never holds more than one (fresh) window per IP that's still
      // making requests.
      this.attempts.set(ip, { count: 1, windowStart: now })
      return true
    }

    if (existing.count >= ENROLL_RATE_LIMIT_ATTEMPTS) {
      throw new HttpException(
        { code: 'rate_limited', message: 'Too many enrolment attempts - try again later' },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    existing.count += 1
    return true
  }
}

// No reverse-proxy header convention exists elsewhere in this codebase yet
// (grepped for x-forwarded-for/req.ip - nothing) - this is the first guard
// that needs a real client IP. X-Forwarded-For's first entry wins when
// present; whatever reverse proxy sits in front of this API in production
// must set it, or every client behind it shares one bucket.
function clientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  return first?.trim() || request.ip || 'unknown'
}
