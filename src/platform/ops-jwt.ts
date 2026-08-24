// The ops auth realm in one place: distinct signing secret, distinct audience
// (AD-3). Tenant tokens are a different issuer entirely - never verified here.
import jwt from 'jsonwebtoken'

export const OPS_JWT_AUDIENCE = 'ops'
export const OPS_SESSION_TTL_SECONDS = 12 * 60 * 60

export interface OpsPrincipal {
  id: string
  email: string
}

function opsJwtSecret(): string {
  const secret = process.env.OPS_JWT_SECRET
  if (!secret) {
    throw new Error('OPS_JWT_SECRET is not set - see .env.example')
  }
  return secret
}

export function signOpsToken(principal: OpsPrincipal): string {
  return jwt.sign({ email: principal.email }, opsJwtSecret(), {
    subject: principal.id,
    audience: OPS_JWT_AUDIENCE,
    expiresIn: OPS_SESSION_TTL_SECONDS,
  })
}

/** Returns the principal for a valid ops-realm token, or null for anything else. */
export function verifyOpsToken(token: string): OpsPrincipal | null {
  try {
    const payload = jwt.verify(token, opsJwtSecret(), { audience: OPS_JWT_AUDIENCE })
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null
    const email: unknown = payload.email
    if (typeof email !== 'string') return null
    return { id: payload.sub, email }
  } catch {
    return null
  }
}
