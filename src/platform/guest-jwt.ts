// The guest realm: distinct signing secret, distinct audience (AD-17) - the
// fifth disjoint realm, same pattern as ops/admin/pos (AD-3/AD-10/AD-13), and
// the first whose principal is not staff. Minted only from a TableSession
// join (start or PIN join) - never an account, never a password. Carries
// sessionId/tenantId/outletId/tableId/name so every guest-facing query can
// scope to the right session and table without a second Guest lookup.
import jwt from 'jsonwebtoken'

export const GUEST_JWT_AUDIENCE = 'guest'
// Matches the TableSession idle-TTL backstop (~4h, SPEC Assumptions) - the
// token should not outlive the session it was minted from by much.
export const GUEST_SESSION_TTL_SECONDS = 4 * 60 * 60

export interface GuestPrincipal {
  id: string
  sessionId: string
  tenantId: string
  outletId: string
  tableId: string
  name: string
}

function guestJwtSecret(): string {
  const secret = process.env.GUEST_JWT_SECRET
  if (!secret) {
    throw new Error('GUEST_JWT_SECRET is not set - see .env.example')
  }
  return secret
}

export function signGuestToken(principal: GuestPrincipal): string {
  return jwt.sign(
    { sessionId: principal.sessionId, tenantId: principal.tenantId, outletId: principal.outletId, tableId: principal.tableId, name: principal.name },
    guestJwtSecret(),
    { subject: principal.id, audience: GUEST_JWT_AUDIENCE, expiresIn: GUEST_SESSION_TTL_SECONDS },
  )
}

/** Returns the principal for a valid guest-realm token, or null for anything else. */
export function verifyGuestToken(token: string): GuestPrincipal | null {
  try {
    const payload = jwt.verify(token, guestJwtSecret(), { audience: GUEST_JWT_AUDIENCE })
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null
    const sessionId: unknown = payload.sessionId
    const tenantId: unknown = payload.tenantId
    const outletId: unknown = payload.outletId
    const tableId: unknown = payload.tableId
    const name: unknown = payload.name
    if (
      typeof sessionId !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof outletId !== 'string' ||
      typeof tableId !== 'string' ||
      typeof name !== 'string'
    ) {
      return null
    }
    return { id: payload.sub, sessionId, tenantId, outletId, tableId, name }
  } catch {
    return null
  }
}
