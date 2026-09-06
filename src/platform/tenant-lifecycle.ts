// Issue #117: the admin, pos and guest realm guards (AD-10/AD-13/AD-17) each
// resolve a tenantId from their own JWT before this runs - this is the one
// place a deactivated or soft-deleted tenant is rejected regardless of realm,
// so it lives once in platform rather than being duplicated per guard the
// way a plain set_config helper is duplicated per module (AD-2).
import type { RegionRegistryService } from './region-registry.service'

/** True once a tenant should stop being served on any realm: deactivated or soft-deleted. */
export async function isTenantBlocked(registry: RegionRegistryService, tenantId: string): Promise<boolean> {
  const plane = registry.planeFor(registry.homeRegion())
  return plane.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true, deletedAt: true } })
    return !tenant || tenant.status === 'inactive' || tenant.deletedAt !== null
  })
}
