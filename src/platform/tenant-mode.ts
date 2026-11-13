// restiq-backend#213: per-tenant Test / Live mode. tenants.live_since is when the tenant last went Live;
// null means Test mode. A bill finalised before live_since was a test sale (a tenant with real sales is
// never switched back to Test - see TenantDirectoryService.setMode), so live_since alone answers both
// "is this tenant in Test mode now" and "was this bill a test sale".
import type { Prisma } from '../generated/prisma/client'

/** Test mode = no live_since. */
export function isTestMode(tenant: { liveSince: Date | null }): boolean {
  return tenant.liveSince === null
}

/** Was a bill finalised (or, still open, being rung up now) while its tenant was in Test mode? */
export function isTestSale(liveSince: Date | null, finalizedAt: Date | null): boolean {
  return liveSince === null || (finalizedAt !== null && finalizedAt < liveSince)
}

/** Reads the tenant's mode inside `tx`, whose RLS context must already allow reading that tenant. */
export async function tenantInTestMode(tx: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { liveSince: true } })
  return tenant !== null && isTestMode(tenant)
}

export interface TenantSummary {
  name: string
  country: string
  /** Shown as a TEST badge in the consoles and on the POS / KDS. */
  testMode: boolean
}

/** The signed-in user's own tenant, for console headers (#213). `tx` must carry that tenant's RLS context. */
export async function readTenantSummary(tx: Prisma.TransactionClient, tenantId: string): Promise<TenantSummary> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, country: true, liveSince: true } })
  return { name: tenant.name, country: tenant.country, testMode: isTestMode(tenant) }
}
