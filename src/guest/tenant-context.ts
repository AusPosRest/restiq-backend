// Shared by every guest service - same one-line RLS helper duplicated per
// module by existing convention (see pos/tenant-context.ts,
// admin/menu/menu-errors.ts's isUniqueViolation) rather than a cross-module
// import for a single set_config call (AD-2: only a module's own barrel is
// importable from outside).
import type { Prisma } from '../generated/prisma/client'

export async function setTenantContext(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}

// Guest entry (AD-17): resolves the owning tenant from an outlet/table row
// BEFORE app.tenant_id is known - see the guest_entry_read RLS policies added
// in 20260829055809_guest_realm_table_sessions/migration.sql for why this is
// safe (narrow, additional SELECT-only policy on outlets/dining_tables).
export async function setGuestEntryContext(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.guest_entry_context', 'guest', true)`
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}
