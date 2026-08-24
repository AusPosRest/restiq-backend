// Shared by every CAP-4 menu service - same pattern as checklist/menu-import.
import type { Prisma } from '../../generated/prisma/client'

export async function setTenantContext(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}
