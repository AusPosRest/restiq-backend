// CAP-4 categories: a routine content edit (SPEC constraint) - no audit
// reason required, unlike price changes.
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { CategoryView, CreateCategoryDto, UpdateCategoryDto } from './categories.dtos'
import { setTenantContext } from './tenant-context'

@Injectable()
export class CategoriesService {
  constructor(private readonly registry: RegionRegistryService) {}

  async list(owner: AdminPrincipal): Promise<CategoryView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const categories = await tx.menuCategory.findMany({
        where: { tenantId: owner.tenantId },
        orderBy: { sortOrder: 'asc' },
        include: { _count: { select: { items: true } } },
      })
      return categories.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder, itemCount: c._count.items }))
    })
  }

  async create(owner: AdminPrincipal, dto: CreateCategoryDto): Promise<CategoryView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const sortOrder = dto.sortOrder ?? (await tx.menuCategory.count({ where: { tenantId: owner.tenantId } }))
      const created = await tx.menuCategory.create({ data: { tenantId: owner.tenantId, name: dto.name, sortOrder } })
      return { id: created.id, name: created.name, sortOrder: created.sortOrder, itemCount: 0 }
    })
  }

  async update(owner: AdminPrincipal, categoryId: string, dto: UpdateCategoryDto): Promise<CategoryView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await tx.menuCategory.findUnique({ where: { id: categoryId } })
      if (!existing || existing.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such category' })
      }
      const updated = await tx.menuCategory.update({
        where: { id: categoryId },
        data: { name: dto.name ?? existing.name, sortOrder: dto.sortOrder ?? existing.sortOrder },
      })
      const itemCount = await tx.menuItem.count({ where: { categoryId } })
      return { id: updated.id, name: updated.name, sortOrder: updated.sortOrder, itemCount }
    })
  }

  async remove(owner: AdminPrincipal, categoryId: string): Promise<void> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await tx.menuCategory.findUnique({ where: { id: categoryId } })
      if (!existing || existing.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such category' })
      }
      const itemCount = await tx.menuItem.count({ where: { categoryId } })
      if (itemCount > 0) {
        throw new ConflictException({ code: 'category_not_empty', message: 'Move or delete this category’s items first' })
      }
      await tx.menuCategory.delete({ where: { id: categoryId } })
    })
  }
}
