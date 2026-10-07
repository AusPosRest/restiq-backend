// The admin (tenant owner) auth realm: distinct signing secret, distinct
// audience (AD-10) - the third disjoint realm, same pattern as ops (AD-3).
// Never verified against the ops secret, and carries tenantId so every
// downstream query can scope to it without trusting client input.
import jwt from 'jsonwebtoken'

export const ADMIN_JWT_AUDIENCE = 'admin'
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60

export interface AdminPrincipal {
  id: string
  tenantId: string
  email: string
  /** Matches OwnerUser.sessionVersion; a reset moves it on and ends every older token. Tokens issued before #181 carry none. */
  sessionVersion?: number
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
    const sv: unknown = payload.sv
    return { id: payload.sub, tenantId, email, ...(typeof sv === 'number' ? { sessionVersion: sv } : {}) }
  } catch {
    return null
  }
}
