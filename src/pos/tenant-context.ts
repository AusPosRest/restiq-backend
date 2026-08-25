// Shared by every pos service - same helper as admin/menu/tenant-context.ts,
// duplicated rather than imported across the module boundary (AD-2: only
// admin's own barrel is importable from outside, and this one-line RLS
// helper isn't part of admin's public surface).
import type { Prisma } from '../generated/prisma/client'

export async function setTenantContext(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}
