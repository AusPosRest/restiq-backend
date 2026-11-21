// The admin (tenant owner) auth realm: distinct signing secret, distinct
// audience (AD-10) - the third disjoint realm, same pattern as ops (AD-3).
// Never verified against the ops secret, and carries tenantId so every
// downstream query can scope to it without trusting client input.
import jwt from 'jsonwebtoken'

export const ADMIN_JWT_AUDIENCE = 'admin'
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60
// #314 service mode: an operator's handoff code (same secret, its own audience - never accepted as a
// session, the same shape as pos-pending) and the shorter session it is swapped for.
export const ADMIN_HANDOFF_JWT_AUDIENCE = 'admin-handoff'
export const SERVICE_HANDOFF_TTL_SECONDS = 60
export const SERVICE_SESSION_TTL_SECONDS = 60 * 60

export interface AdminPrincipal {
  id: string
  tenantId: string
  email: string
  /** Matches OwnerUser.sessionVersion; a reset moves it on and ends every older token. Tokens issued before #181 carry none. */
  sessionVersion?: number
  /** #314: an operator in service mode; `id`/`email` are the operator's, never an owner's. */
  service?: true
  /** #314: OperatorUser.sessionVersion when the service token was issued; an ops logout ends the session. */
  operatorSessionVersion?: number
  /** #314: the service token's `exp` (seconds). */
  expiresAt?: number
}

/** #314: what an ops service-session handoff code carries. */
export interface ServiceHandoff {
  operatorId: string
  operatorEmail: string
  tenantId: string
  operatorSessionVersion?: number
}

function adminJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET
  if (!secret) {
    throw new Error('ADMIN_JWT_SECRET is not set - see .env.example')
  }
  return secret
}

export function signAdminToken(principal: AdminPrincipal): string {
  return jwt.sign({ email: principal.email, tenantId: principal.tenantId, ...(principal.sessionVersion === undefined ? {} : { sv: principal.sessionVersion }) }, adminJwtSecret(), {
    subject: principal.id,
    audience: ADMIN_JWT_AUDIENCE,
    expiresIn: ADMIN_SESSION_TTL_SECONDS,
  })
}

/** Returns the principal for a valid admin-realm token, or null for anything else. */
export function verifyAdminToken(token: string): AdminPrincipal | null {
  try {
    const payload = jwt.verify(token, adminJwtSecret(), { audience: ADMIN_JWT_AUDIENCE })
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null
    const email: unknown = payload.email
    const tenantId: unknown = payload.tenantId
    if (typeof email !== 'string' || typeof tenantId !== 'string') return null
    // #314: a service token never fills the owner sessionVersion, so the guard checks the operator instead.
    if (payload.svc === true) {
      const osv: unknown = payload.osv
      if (typeof payload.exp !== 'number') return null
      return { id: payload.sub, tenantId, email, service: true, expiresAt: payload.exp, ...(typeof osv === 'number' ? { operatorSessionVersion: osv } : {}) }
    }
    const sv: unknown = payload.sv
    return { id: payload.sub, tenantId, email, ...(typeof sv === 'number' ? { sessionVersion: sv } : {}) }
  } catch {
    return null
  }
}

/** #314: the admin-realm session an operator gets in service mode - 1 h, marked `svc`. */
export function signServiceToken(handoff: ServiceHandoff): string {
  const osv = handoff.operatorSessionVersion === undefined ? {} : { osv: handoff.operatorSessionVersion }
  return jwt.sign({ email: handoff.operatorEmail, tenantId: handoff.tenantId, svc: true, ...osv }, adminJwtSecret(), {
    subject: handoff.operatorId,
    audience: ADMIN_JWT_AUDIENCE,
    expiresIn: SERVICE_SESSION_TTL_SECONDS,
  })
}

// ponytail: the handoff code is a 60 s signed token, not a stored one-time row; add a table if replay within 60 s or a list of past service sessions ever matters.
export function signServiceHandoff(handoff: ServiceHandoff): string {
  const sv = handoff.operatorSessionVersion === undefined ? {} : { sv: handoff.operatorSessionVersion }
  return jwt.sign({ tenantId: handoff.tenantId, email: handoff.operatorEmail, ...sv }, adminJwtSecret(), {
    subject: handoff.operatorId,
    audience: ADMIN_HANDOFF_JWT_AUDIENCE,
    expiresIn: SERVICE_HANDOFF_TTL_SECONDS,
  })
}

/** Returns the handoff for a valid, unexpired code, or null for anything else (bad, expired, wrong audience). */
export function verifyServiceHandoff(code: string): ServiceHandoff | null {
  try {
    const payload = jwt.verify(code, adminJwtSecret(), { audience: ADMIN_HANDOFF_JWT_AUDIENCE })
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null
    const tenantId: unknown = payload.tenantId
    const email: unknown = payload.email
    if (typeof tenantId !== 'string' || typeof email !== 'string') return null
    const sv: unknown = payload.sv
    return { operatorId: payload.sub, operatorEmail: email, tenantId, ...(typeof sv === 'number' ? { operatorSessionVersion: sv } : {}) }
  } catch {
    return null
  }
}
