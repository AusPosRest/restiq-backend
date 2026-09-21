// restiq-backend#171: the client address sign-in throttling keys on.
//
// Browsers don't call the sign-in routes directly - the web app's own server
// routes (restiq-web src/app/{pos,admin,ops}/auth/login/route.ts) make the
// call, so req.ip is the web server, the same for every customer. Those routes
// pass the browser's address in X-Restiq-Client-Ip, and it is believed only
// when X-Restiq-Proxy-Secret matches PROXY_SHARED_SECRET (constant-time) - a
// caller who can't prove it is our web server can't pick its own address.
// Otherwise: req.ip, resolved through TRUST_PROXY_HOPS (main.ts).
import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Request } from 'express'

export const CLIENT_IP_HEADER = 'x-restiq-client-ip'
export const PROXY_SECRET_HEADER = 'x-restiq-proxy-secret'

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function resolveClientIp(request: Pick<Request, 'ip' | 'headers'>): string {
  const secret = process.env.PROXY_SHARED_SECRET
  const forwarded = request.headers[CLIENT_IP_HEADER]
  const given = request.headers[PROXY_SECRET_HEADER]
  if (secret && typeof forwarded === 'string' && isIP(forwarded) !== 0 && secretMatches(typeof given === 'string' ? given : undefined, secret)) {
    return forwarded
  }
  return request.ip ?? 'unknown'
}

/** The caller's address for throttling - see the file header for when a forwarded one is believed. */
export const ClientIp = createParamDecorator((_data: unknown, context: ExecutionContext): string =>
  resolveClientIp(context.switchToHttp().getRequest<Request>()),
)
