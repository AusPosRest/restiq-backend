// Shared by every kitchen service - same one-line RLS helper duplicated per
// module by existing convention (see pos/tenant-context.ts,
// admin/menu/tenant-context.ts) rather than imported across the module
// boundary (AD-2: only a module's own barrel is importable from outside).
import type { Prisma } from '../generated/prisma/client'

export async function setTenantContext(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}
