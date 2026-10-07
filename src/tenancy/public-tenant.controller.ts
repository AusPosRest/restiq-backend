// What a sign-in page needs to know about the restaurant at this address (D14). Public: it returns
// only the name, country, currency and look - nothing a visitor could not read off the page itself.
import { Controller, Get, Headers, NotFoundException, Query } from '@nestjs/common'
import { baseDomain, RegionRegistryService, slugFromHost } from '../platform'

export interface TenantPublicView {
  tenantId: string
  slug: string
  displayName: string
  status: 'provisioning' | 'active' | 'suspended'
  country: 'IN' | 'AU'
  currency: 'INR' | 'AUD'
  branding: Record<string, unknown>
}

@Controller('public/v1')
export class PublicTenantController {
  constructor(private readonly registry: RegionRegistryService) {}

  // The web server asks on the visitor's behalf and passes their address in `host`; a browser that
  // calls directly is read from the Host header. Only addresses under BASE_DOMAIN name a tenant.
  @Get('tenant')
  async resolve(@Query('host') hostParam: string | undefined, @Headers('host') hostHeader: string | undefined): Promise<TenantPublicView> {
    const slug = slugFromHost(hostParam ?? hostHeader ?? '', baseDomain())
    const plane = this.registry.planeFor(this.registry.homeRegion())
    const tenant = slug
      ? await plane.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
          return tx.tenant.findFirst({ where: { slug, deletedAt: null } })
        })
      : null
    if (!tenant?.slug) throw new NotFoundException({ code: 'tenant_not_found', message: 'No restaurant uses this address' })
    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      displayName: tenant.name,
      status: tenant.status === 'inactive' ? 'suspended' : tenant.status,
      country: tenant.country,
      currency: tenant.country === 'IN' ? 'INR' : 'AUD',
      branding: (tenant.brandingTokens ?? {}) as Record<string, unknown>,
    }
  }
}
