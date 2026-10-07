// Which tenant's address a request came to (D14). Browsers talk to our web server, which calls this
// API, so the API never sees the tenant's own host. The web server forwards it in X-Restiq-Tenant-Host
// and proves it is our web server with the shared proxy secret (same rule as the client address, see
// client-ip.ts). When that proof is there, a token for another tenant is refused: 403 tenant_mismatch.
// No header (direct API calls, tests, apps without a host) -> no check, behaviour unchanged.
import { ForbiddenException, Injectable } from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import { RegionRegistryService } from './region-registry.service'
import { slugFromHost } from './tenant-slug'

export const TENANT_HOST_HEADER = 'x-restiq-tenant-host'
const PROXY_SECRET_HEADER = 'x-restiq-proxy-secret'

export function baseDomain(): string {
  return process.env.BASE_DOMAIN ?? 'idelta.com.au'
}

function proxyIsTrusted(headers: Request['headers']): boolean {
  const secret = process.env.PROXY_SHARED_SECRET
  const given = headers[PROXY_SECRET_HEADER]
  if (!secret || typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

@Injectable()
export class TenantAddressService {
  // A slug never changes once set, so a found tenant id is safe to keep. Misses are not kept (a slug may be given later).
  private readonly idBySlug = new Map<string, string>()

  constructor(private readonly registry: RegionRegistryService) {}

  /** The slug the visitor's address names, believed only when the proxy proves it is our web server. */
  slugOf(request: Pick<Request, 'headers'>): string | null {
    const host = request.headers[TENANT_HOST_HEADER]
    if (typeof host !== 'string' || !proxyIsTrusted(request.headers)) return null
    return slugFromHost(host, baseDomain())
  }

  async tenantIdForSlug(slug: string): Promise<string | null> {
    const known = this.idBySlug.get(slug)
    if (known) return known
    const plane = this.registry.planeFor(this.registry.homeRegion())
    const tenant = await plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.operator_context', 'operator', true)`
      return tx.tenant.findUnique({ where: { slug }, select: { id: true } })
    })
    if (tenant) this.idBySlug.set(slug, tenant.id)
    return tenant?.id ?? null
  }

  /** Refuses a token whose tenant is not the tenant whose address the request came to. */
  async assertTokenMatchesAddress(request: Pick<Request, 'headers'>, tokenTenantId: string): Promise<void> {
    const slug = this.slugOf(request)
    if (!slug) return
    if ((await this.tenantIdForSlug(slug)) !== tokenTenantId) {
      throw new ForbiddenException({ code: 'tenant_mismatch', message: 'This session belongs to a different restaurant' })
    }
  }
}
