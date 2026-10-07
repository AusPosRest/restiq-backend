// Product directory (#153). One service, two realms (same AD-12 shape as
// AgreementsService): operators curate under /ops, owners browse and import
// under /admin. An import copies rows into the tenant's own menu through the
// same commitItems helper the menu-import commit uses.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { commitItems, CommitItemsResult, currencyForCountry } from '../../admin/menu/commit-items'
import { AdminPrincipal, ControlPlaneAuditService, OpsPrincipal, RegionRegistryService } from '../../platform'
import { CatalogListQuery, CatalogProductView, CreateCatalogProductDto, UpdateCatalogProductDto } from './catalog.dtos'

type ProductRow = {
  id: string
  name: string
  shortName: string
  nameHindi: string | null
  vegMarker: CatalogProductView['vegMarker']
  photoUrl: string | null
  category: string
  suggestedPriceMinor: bigint
  currency: string
  tags: string[]
  updatedAt: Date
}

function toView(row: ProductRow): CatalogProductView {
  return {
    id: row.id,
    name: row.name,
    shortName: row.shortName,
    nameHindi: row.nameHindi,
    vegMarker: row.vegMarker,
    photoUrl: row.photoUrl,
    category: row.category,
    suggestedPriceMinor: Number(row.suggestedPriceMinor),
    currency: row.currency,
    tags: row.tags,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function normaliseTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

function whereFor(query: CatalogListQuery): Prisma.CatalogProductWhereInput {
  const where: Prisma.CatalogProductWhereInput = {}
  const q = query.q?.trim()
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
      { tags: { has: q.toLowerCase() } },
    ]
  }
  if (query.tag) where.tags = { has: query.tag.toLowerCase() }
  if (query.currency) where.currency = query.currency
  return where
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  // ponytail: products live on the home region plane only; fan out per region if a second region ever ships.
  private get plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async list(query: CatalogListQuery): Promise<{ products: CatalogProductView[] }> {
    const rows = await this.plane.catalogProduct.findMany({ where: whereFor(query), orderBy: [{ category: 'asc' }, { name: 'asc' }] })
    return { products: rows.map(toView) }
  }

  async tags(currency?: string): Promise<{ tags: string[] }> {
    // ponytail: distinct-unnest over the whole table; fine until the directory is tens of thousands of rows.
    const rows = currency
      ? await this.plane.$queryRaw<Array<{ tag: string }>>`SELECT DISTINCT unnest(tags) AS tag FROM catalog_products WHERE currency = ${currency} ORDER BY 1`
      : await this.plane.$queryRaw<Array<{ tag: string }>>`SELECT DISTINCT unnest(tags) AS tag FROM catalog_products ORDER BY 1`
    return { tags: rows.map((row) => row.tag) }
  }

  async create(operator: OpsPrincipal, dto: CreateCatalogProductDto): Promise<{ product: CatalogProductView }> {
    const row = await this.plane.catalogProduct.create({ data: { ...dto, tags: normaliseTags(dto.tags) ?? [] } })
    await this.audit.record({ actorId: operator.id, actorEmail: operator.email, action: 'catalog.product.created', reason: row.name, occurredAt: new Date() })
    return { product: toView(row) }
  }

  async update(operator: OpsPrincipal, id: string, dto: UpdateCatalogProductDto): Promise<{ product: CatalogProductView }> {
    await this.mustExist(id)
    const row = await this.plane.catalogProduct.update({ where: { id }, data: { ...dto, tags: normaliseTags(dto.tags) } })
    await this.audit.record({ actorId: operator.id, actorEmail: operator.email, action: 'catalog.product.updated', reason: row.name, occurredAt: new Date() })
    return { product: toView(row) }
  }

  async remove(operator: OpsPrincipal, id: string, reason?: string): Promise<void> {
    const row = await this.mustExist(id)
    await this.plane.catalogProduct.delete({ where: { id } })
    const why = reason?.trim().slice(0, 500)
    await this.audit.record({
      actorId: operator.id,
      actorEmail: operator.email,
      action: 'catalog.product.deleted',
      reason: why ? `${row.name}: ${why}` : row.name,
      occurredAt: new Date(),
    })
  }

  // --- Owner realm -------------------------------------------------------

  async listForTenant(owner: AdminPrincipal, query: Omit<CatalogListQuery, 'currency'>): Promise<{ products: CatalogProductView[] }> {
    return this.list({ ...query, currency: await this.tenantCurrency(owner.tenantId) })
  }

  async tagsForTenant(owner: AdminPrincipal): Promise<{ tags: string[] }> {
    return this.tags(await this.tenantCurrency(owner.tenantId))
  }

  async importForTenant(owner: AdminPrincipal, productIds: string[]): Promise<CommitItemsResult> {
    const currency = await this.tenantCurrency(owner.tenantId)
    try {
      return await this.plane.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${owner.tenantId}, true)`
      const products = await tx.catalogProduct.findMany({ where: { id: { in: productIds }, currency } })
      if (products.length !== productIds.length) {
        throw new BadRequestException({ code: 'validation_failed', message: 'One or more products are not in the directory for this tenant' })
      }
      const result = await commitItems(
        tx,
        owner.tenantId,
        products.map((p) => ({
          name: p.name,
          shortName: p.shortName,
          category: p.category,
          priceMinor: Number(p.suggestedPriceMinor),
          currency: p.currency,
          photoUrl: p.photoUrl,
          nameHindi: p.nameHindi,
          vegMarker: p.vegMarker,
        })),
      )
      await tx.auditEvent.create({
        data: {
          tenantId: owner.tenantId,
          actorId: owner.id,
          actorEmail: owner.email,
          action: 'menu.imported',
          reason: `Imported ${result.items.length} item(s) from the product directory`,
          occurredAt: new Date(),
        },
      })
      return result
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'conflict', message: 'One or more of these items are already on your menu under the same category' })
      }
      throw error
    }
  }

  private async tenantCurrency(tenantId: string): Promise<string> {
    const tenant = await this.plane.tenant.findUnique({ where: { id: tenantId }, select: { country: true } })
    if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })
    return currencyForCountry(tenant.country)
  }

  private async mustExist(id: string): Promise<{ name: string }> {
    const row = await this.plane.catalogProduct.findUnique({ where: { id }, select: { name: true } })
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'No such product' })
    return row
  }
}
