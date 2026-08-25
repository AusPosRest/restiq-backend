// The pos (POS terminal staff) auth realm: distinct signing secret, distinct
// audience (AD-13) - the fourth disjoint realm, same pattern as ops (AD-3)
// and admin (AD-10). Carries staffId/tenantId/outletId so every downstream
// query can scope to them without trusting client input.
//
// STUB NOTICE: issue #44 (pos/CAP-1 PIN login) owns the real login endpoint
// that mints these tokens (PIN verified against StaffUser.pinHash, argon2,
// per AD-13). That endpoint isn't committed yet, so this file only provides
// sign/verify - no login controller. Once #44 merges, reconcile: it should
// call signPosToken() here rather than re-deriving its own signing logic,
// and this notice should be deleted.
import jwt from 'jsonwebtoken'

export const POS_JWT_AUDIENCE = 'pos'
export const POS_SESSION_TTL_SECONDS = 12 * 60 * 60

export interface PosPrincipal {
  id: string
  tenantId: string
  outletId: string
  name: string
}

function posJwtSecret(): string {
  const secret = process.env.POS_JWT_SECRET
  if (!secret) {
    throw new Error('POS_JWT_SECRET is not set - see .env.example')
  }
  return secret
}

export function signPosToken(principal: PosPrincipal): string {
  return jwt.sign({ name: principal.name, tenantId: principal.tenantId, outletId: principal.outletId }, posJwtSecret(), {
    subject: principal.id,
    audience: POS_JWT_AUDIENCE,
    expiresIn: POS_SESSION_TTL_SECONDS,
  })
}

/** Returns the principal for a valid pos-realm token, or null for anything else. */
export function verifyPosToken(token: string): PosPrincipal | null {
  try {
    const payload = jwt.verify(token, posJwtSecret(), { audience: POS_JWT_AUDIENCE })
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null
    const name: unknown = payload.name
    const tenantId: unknown = payload.tenantId
    const outletId: unknown = payload.outletId
    if (typeof name !== 'string' || typeof tenantId !== 'string' || typeof outletId !== 'string') return null
    return { id: payload.sub, tenantId, outletId, name }
  } catch {
    return null
  }
}
