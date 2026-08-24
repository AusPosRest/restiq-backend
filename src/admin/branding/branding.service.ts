// CAP-10 branding tokens: stored on the tenant's existing branding_tokens
// JSON column (added for guest-facing surfaces at onboarding) rather than a
// new table - Tenant Admin becomes a second reader/writer of the same flat
// token map, not a competing store. A routine content edit (SPEC constraint)
// - no audit reason required.
import { Injectable, NotFoundException } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../menu/tenant-context'
import { BrandingView, UpdateBrandingDto } from './branding.dtos'

const FIELDS = ['primaryColor', 'secondaryColor', 'accentColor', 'surfaceColor', 'font', 'cornerRadiusPx', 'logoUrl', 'receiptHeader', 'receiptFooter'] as const

type Field = (typeof FIELDS)[number]
type TokenMap = Partial<Record<Field, string | number>>

function isTokenMap(value: unknown): value is TokenMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toView(tokens: unknown): BrandingView {
  const map = isTokenMap(tokens) ? tokens : {}
  return {
    primaryColor: typeof map.primaryColor === 'string' ? map.primaryColor : null,
    secondaryColor: typeof map.secondaryColor === 'string' ? map.secondaryColor : null,
    accentColor: typeof map.accentColor === 'string' ? map.accentColor : null,
    surfaceColor: typeof map.surfaceColor === 'string' ? map.surfaceColor : null,
    font: typeof map.font === 'string' ? map.font : null,
    cornerRadiusPx: typeof map.cornerRadiusPx === 'number' ? map.cornerRadiusPx : null,
    logoUrl: typeof map.logoUrl === 'string' ? map.logoUrl : null,
    receiptHeader: typeof map.receiptHeader === 'string' ? map.receiptHeader : null,
    receiptFooter: typeof map.receiptFooter === 'string' ? map.receiptFooter : null,
  }
}

@Injectable()
export class BrandingService {
  constructor(private readonly registry: RegionRegistryService) {}

  async get(owner: AdminPrincipal): Promise<BrandingView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const tenant = await tx.tenant.findUnique({ where: { id: owner.tenantId }, select: { brandingTokens: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
      return toView(tenant.brandingTokens)
    })
  }

  async update(owner: AdminPrincipal, dto: UpdateBrandingDto): Promise<BrandingView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const tenant = await tx.tenant.findUnique({ where: { id: owner.tenantId }, select: { brandingTokens: true } })
      if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })

      const existing = isTokenMap(tenant.brandingTokens) ? tenant.brandingTokens : {}
      const merged: TokenMap = { ...existing }
      for (const field of FIELDS) {
        const value = dto[field]
        if (value !== undefined) merged[field] = value
      }

      const updated = await tx.tenant.update({ where: { id: owner.tenantId }, data: { brandingTokens: merged } })
      return toView(updated.brandingTokens)
    })
  }
}
