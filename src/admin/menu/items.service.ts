// CAP-4 items: the item itself, its variants, its modifier-group and
// allergen links, the 86 (availability) toggle, and per-outlet availability
// overrides. Price writes live in PricesService (a distinct file - the one
// AD-11 insert-only code path, kept apart so nothing else can grow a second
// way to change a price).
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { CreateItemDto, CreateVariantDto, ItemView, UpdateItemDto, VariantView } from './items.dtos'
import { isUniqueViolation } from './menu-errors'
import { setTenantContext } from './tenant-context'

type ItemWithRelations = Prisma.MenuItemGetPayload<{
  include: {
    variants: true
    modifierGroups: { include: { group: { include: { modifiers: true } } } }
    allergens: { include: { allergen: true } }
  }
}>

const ITEM_INCLUDE = {
  variants: { orderBy: { sortOrder: 'asc' } },
  modifierGroups: { include: { group: { include: { modifiers: { orderBy: { sortOrder: 'asc' } } } } } },
  allergens: { include: { allergen: true } },
} satisfies Prisma.MenuItemInclude

function toView(item: ItemWithRelations): ItemView {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    shortName: item.shortName,
    available: item.available,
    stationId: item.stationId,
    variants: item.variants.map((v) => ({ id: v.id, name: v.name, sortOrder: v.sortOrder })),
    modifierGroups: item.modifierGroups.map((link) => ({
      id: link.group.id,
      name: link.group.name,
      minSelections: link.group.minSelections,
      maxSelections: link.group.maxSelections,
      modifiers: link.group.modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.priceMinor) })),
    })),
    allergens: item.allergens.map((link) => ({ id: link.allergen.id, name: link.allergen.name })),
  }
}

async function loadItem(tx: Prisma.TransactionClient, tenantId: string, itemId: string): Promise<ItemWithRelations> {
  const item = await tx.menuItem.findUnique({ where: { id: itemId }, include: ITEM_INCLUDE })
  if (!item || item.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such menu item' })
  }
  return item
}

async function createVariants(tx: Prisma.TransactionClient, tenantId: string, itemId: string, variants: CreateVariantDto[]): Promise<void> {
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]
    if (!v) continue
    await tx.itemVariant.create({ data: { tenantId, itemId, name: v.name, sortOrder: v.sortOrder ?? i } })
  }
}

async function assertOwnedByTenant(tx: Prisma.TransactionClient, tenantId: string, ids: string[], find: (id: string) => Promise<{ tenantId: string } | null>, code: string, message: string): Promise<void> {
  for (const id of ids) {
    const row = await find(id)
    if (!row || row.tenantId !== tenantId) {
      throw new BadRequestException({ code, message })
    }
  }
}

@Injectable()
export class ItemsService {
  constructor(private readonly registry: RegionRegistryService) {}

  async list(owner: AdminPrincipal, categoryId?: string): Promise<ItemView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const items = await tx.menuItem.findMany({
        where: { tenantId: owner.tenantId, ...(categoryId ? { categoryId } : {}) },
        include: ITEM_INCLUDE,
        orderBy: { createdAt: 'asc' },
      })
      return items.map(toView)
    })
  }

  async get(owner: AdminPrincipal, itemId: string): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => toView(await loadItem(tx, owner.tenantId, itemId)))
  }

  async create(owner: AdminPrincipal, dto: CreateItemDto): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    try {
      return await plane.$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        const category = await tx.menuCategory.findUnique({ where: { id: dto.categoryId } })
        if (!category || category.tenantId !== owner.tenantId) {
          throw new BadRequestException({ code: 'validation_failed', message: 'No such category' })
        }
        if (dto.modifierGroupIds?.length) {
          await assertOwnedByTenant(tx, owner.tenantId, dto.modifierGroupIds, (id) => tx.modifierGroup.findUnique({ where: { id } }), 'validation_failed', 'No such modifier group')
        }
        if (dto.allergenIds?.length) {
          await assertOwnedByTenant(tx, owner.tenantId, dto.allergenIds, (id) => tx.allergen.findUnique({ where: { id } }), 'validation_failed', 'No such allergen')
        }
        if (dto.stationId) {
          await assertOwnedByTenant(tx, owner.tenantId, [dto.stationId], (id) => tx.station.findUnique({ where: { id } }), 'validation_failed', 'No such station')
        }

        const item = await tx.menuItem.create({ data: { tenantId: owner.tenantId, categoryId: dto.categoryId, name: dto.name, shortName: dto.shortName, stationId: dto.stationId ?? null } })
        await createVariants(tx, owner.tenantId, item.id, dto.variants ?? [])
        for (const groupId of dto.modifierGroupIds ?? []) {
          await tx.itemModifierGroup.create({ data: { tenantId: owner.tenantId, itemId: item.id, groupId, sortOrder: 0 } })
        }
        for (const allergenId of dto.allergenIds ?? []) {
          await tx.itemAllergen.create({ data: { tenantId: owner.tenantId, itemId: item.id, allergenId } })
        }

        return toView(await loadItem(tx, owner.tenantId, item.id))
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'conflict', message: 'An item with this name already exists in this category' })
      }
      throw error
    }
  }

  async update(owner: AdminPrincipal, itemId: string, dto: UpdateItemDto): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await loadItem(tx, owner.tenantId, itemId)
      if (dto.categoryId) {
        const category = await tx.menuCategory.findUnique({ where: { id: dto.categoryId } })
        if (!category || category.tenantId !== owner.tenantId) {
          throw new BadRequestException({ code: 'validation_failed', message: 'No such category' })
        }
      }
      await tx.menuItem.update({
        where: { id: itemId },
        data: { name: dto.name ?? existing.name, shortName: dto.shortName ?? existing.shortName, categoryId: dto.categoryId ?? existing.categoryId },
      })
      return toView(await loadItem(tx, owner.tenantId, itemId))
    })
  }

  // 86 toggle (CAP-4 success criterion): immediate, reflected in the same
  // request - not versioned, not audited (only price changes carry that
  // SPEC obligation).
  async setAvailability(owner: AdminPrincipal, itemId: string, available: boolean): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadItem(tx, owner.tenantId, itemId)
      await tx.menuItem.update({ where: { id: itemId }, data: { available } })
      return toView(await loadItem(tx, owner.tenantId, itemId))
    })
  }

  // kitchen-display/CAP-1 (AD-16): one schema owner - Tenant Admin's menu
  // editor is the sole writer of item->station routing. stationId undefined
  // clears the route back to unrouted (see SetStationDto's comment).
  async setStation(owner: AdminPrincipal, itemId: string, stationId: string | undefined): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadItem(tx, owner.tenantId, itemId)
      if (stationId) {
        await assertOwnedByTenant(tx, owner.tenantId, [stationId], (id) => tx.station.findUnique({ where: { id } }), 'validation_failed', 'No such station')
      }
      await tx.menuItem.update({ where: { id: itemId }, data: { stationId: stationId ?? null } })
      return toView(await loadItem(tx, owner.tenantId, itemId))
    })
  }

  async addVariant(owner: AdminPrincipal, itemId: string, dto: CreateVariantDto): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    try {
      return await plane.$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        const existing = await loadItem(tx, owner.tenantId, itemId)
        await tx.itemVariant.create({ data: { tenantId: owner.tenantId, itemId, name: dto.name, sortOrder: dto.sortOrder ?? existing.variants.length } })
        return toView(await loadItem(tx, owner.tenantId, itemId))
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'conflict', message: 'A variant with this name already exists on this item' })
      }
      throw error
    }
  }

  async removeVariant(owner: AdminPrincipal, itemId: string, variantId: string): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadItem(tx, owner.tenantId, itemId)
      const variant = await tx.itemVariant.findUnique({ where: { id: variantId } })
      if (!variant || variant.tenantId !== owner.tenantId || variant.itemId !== itemId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such variant' })
      }
      await tx.itemVariant.delete({ where: { id: variantId } })
      return toView(await loadItem(tx, owner.tenantId, itemId))
    })
  }

  async replaceModifierGroups(owner: AdminPrincipal, itemId: string, groupIds: string[]): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadItem(tx, owner.tenantId, itemId)
      await assertOwnedByTenant(tx, owner.tenantId, groupIds, (id) => tx.modifierGroup.findUnique({ where: { id } }), 'validation_failed', 'No such modifier group')
      await tx.itemModifierGroup.deleteMany({ where: { itemId } })
      for (const [i, groupId] of groupIds.entries()) {
        await tx.itemModifierGroup.create({ data: { tenantId: owner.tenantId, itemId, groupId, sortOrder: i } })
      }
      return toView(await loadItem(tx, owner.tenantId, itemId))
    })
  }

  async replaceAllergens(owner: AdminPrincipal, itemId: string, allergenIds: string[]): Promise<ItemView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadItem(tx, owner.tenantId, itemId)
      await assertOwnedByTenant(tx, owner.tenantId, allergenIds, (id) => tx.allergen.findUnique({ where: { id } }), 'validation_failed', 'No such allergen')
      await tx.itemAllergen.deleteMany({ where: { itemId } })
      for (const allergenId of allergenIds) {
        await tx.itemAllergen.create({ data: { tenantId: owner.tenantId, itemId, allergenId } })
      }
      return toView(await loadItem(tx, owner.tenantId, itemId))
    })
  }

  async setOutletAvailability(owner: AdminPrincipal, itemId: string, outletId: string, available: boolean): Promise<{ itemId: string; outletId: string; available: boolean }> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadItem(tx, owner.tenantId, itemId)
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || outlet.tenantId !== owner.tenantId) {
        throw new BadRequestException({ code: 'validation_failed', message: 'No such outlet' })
      }
      await tx.itemOutletOverride.upsert({
        where: { itemId_outletId: { itemId, outletId } },
        create: { tenantId: owner.tenantId, itemId, outletId, available },
        update: { available },
      })
      return { itemId, outletId, available }
    })
  }

  async clearOutletAvailability(owner: AdminPrincipal, itemId: string, outletId: string): Promise<void> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    await plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadItem(tx, owner.tenantId, itemId)
      await tx.itemOutletOverride.deleteMany({ where: { itemId, outletId } })
    })
  }
}

export type { VariantView }
