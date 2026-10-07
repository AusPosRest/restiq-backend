// The pos (cashier/waiter) auth realm: distinct signing secret, distinct
// audience (AD-13) - the fourth disjoint realm, same pattern as ops/admin
// (AD-3/AD-10). Login is PIN-based and, per AD-13, a pos session is not
// bound to an enrolled Device row - any authenticated browser can act as a
// terminal for this prototype. Carries staffId/tenantId/outletId/name so
// every downstream query - and audit rows that need a human-readable actor,
// e.g. pos/orders' ownership-transfer log - can use it without a second
// StaffUser lookup.
//
// A tenant with more than one outlet needs a second step (pick the outlet)
// between "PIN verified" and "pos session issued". That intermediate state
// is its own token with a different audience (`pos-pending`) so it can never
// satisfy the real pos guard even though it is signed with the same secret -
// the same "different audience, not a second secret" shape as the two real
// realms, scoped down for a short-lived, single-purpose handoff.
import jwt from 'jsonwebtoken'

export const POS_JWT_AUDIENCE = 'pos'
export const POS_PENDING_JWT_AUDIENCE = 'pos-pending'
export const POS_SESSION_TTL_SECONDS = 12 * 60 * 60
// Just long enough to read an outlet list and tap one - not a session.
export const POS_PENDING_TTL_SECONDS = 5 * 60

// restiq-backend#169: the token also carries `sv`, the staff member's
// sessionVersion when it was issued. The guard re-reads the staff row on every
// request and refuses the token once they differ (PIN revoked or reissued,
// role changed, logout). A token with no `sv` - anything issued before #169 -
// is refused outright, so everyone logs in once more after that deploy. The
// role is deliberately NOT in the token: the guard reads it from the database.
export interface PosPrincipal {
  id: string
  tenantId: string
  outletId: string
  name: string
  /** Role name, read from the database by PosAuthGuard on every request - never from the token. */
  role: string
}

export type PosTokenClaims = Omit<PosPrincipal, 'role'> & { sessionVersion: number }

export interface PosPendingPrincipal {
  id: string
  tenantId: string
}

function posJwtSecret(): string {
  const secret = process.env.POS_JWT_SECRET
  if (!secret) {
    throw new Error('POS_JWT_SECRET is not set - see .env.example')
  }
  return secret
}

export function signPosToken(principal: PosTokenClaims): string {
  return jwt.sign({ tenantId: principal.tenantId, outletId: principal.outletId, name: principal.name, sv: principal.sessionVersion }, posJwtSecret(), {
    subject: principal.id,
    audience: POS_JWT_AUDIENCE,
    expiresIn: POS_SESSION_TTL_SECONDS,
  })
}

/** Returns the claims of a valid pos-realm token, or null for anything else (including a token without `sv`). */
export function verifyPosToken(token: string): PosTokenClaims | null {
  try {
    const payload = jwt.verify(token, posJwtSecret(), { audience: POS_JWT_AUDIENCE })
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null
    const tenantId: unknown = payload.tenantId
    const outletId: unknown = payload.outletId
    const name: unknown = payload.name
    const sv: unknown = payload.sv
    if (typeof tenantId !== 'string' || typeof outletId !== 'string' || typeof name !== 'string') return null
    if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 0) return null
    return { id: payload.sub, tenantId, outletId, name, sessionVersion: sv }
  } catch {
    return null
  }
}

export function signPosPendingToken(principal: PosPendingPrincipal): string {
  return jwt.sign({ tenantId: principal.tenantId }, posJwtSecret(), {
    subject: principal.id,
    audience: POS_PENDING_JWT_AUDIENCE,
    expiresIn: POS_PENDING_TTL_SECONDS,
  })
}

/** Returns the principal for a valid outlet-selection handoff token, or null. */
export function verifyPosPendingToken(token: string): PosPendingPrincipal | null {
  try {
    const payload = jwt.verify(token, posJwtSecret(), { audience: POS_PENDING_JWT_AUDIENCE })
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null
    const tenantId: unknown = payload.tenantId
    if (typeof tenantId !== 'string') return null
    return { id: payload.sub, tenantId }
  } catch {
    return null
  }
}
