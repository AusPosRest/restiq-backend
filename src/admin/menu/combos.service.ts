// CAP-4 combos - a flat-priced bundle of existing items. Not versioned
// (AD-11 binds item_prices, not combos) - a routine content edit like any
// other CRUD in this module.
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { ComboView, CreateComboDto } from './combos.dtos'
import { isUniqueViolation } from './menu-errors'
import { setTenantContext } from './tenant-context'

@Injectable()
export class CombosService {
  constructor(private readonly registry: RegionRegistryService) {}

  async list(owner: AdminPrincipal): Promise<ComboView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const combos = await tx.combo.findMany({ where: { tenantId: owner.tenantId }, include: { components: true }, orderBy: { name: 'asc' } })
      return combos.map((c) => ({
        id: c.id,
        name: c.name,
        categoryId: c.categoryId,
        priceMinor: Number(c.priceMinor),
        currency: c.currency,
        components: c.components.map((comp) => ({ itemId: comp.itemId, quantity: comp.quantity })),
      }))
    })
  }

  async create(owner: AdminPrincipal, dto: CreateComboDto): Promise<ComboView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    try {
      return await plane.$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        for (const component of dto.components) {
          const item = await tx.menuItem.findUnique({ where: { id: component.itemId } })
          if (!item || item.tenantId !== owner.tenantId) {
            throw new BadRequestException({ code: 'validation_failed', message: `No such item: ${component.itemId}` })
          }
        }
        if (dto.categoryId) {
          const category = await tx.menuCategory.findUnique({ where: { id: dto.categoryId } })
          if (!category || category.tenantId !== owner.tenantId) {
            throw new BadRequestException({ code: 'validation_failed', message: 'No such category' })
          }
        }

        const combo = await tx.combo.create({
          data: { tenantId: owner.tenantId, name: dto.name, categoryId: dto.categoryId ?? null, priceMinor: BigInt(dto.priceMinor), currency: dto.currency },
        })
        for (const component of dto.components) {
          await tx.comboComponent.create({ data: { tenantId: owner.tenantId, comboId: combo.id, itemId: component.itemId, quantity: component.quantity ?? 1 } })
        }

        return {
          id: combo.id,
          name: combo.name,
          categoryId: combo.categoryId,
          priceMinor: Number(combo.priceMinor),
          currency: combo.currency,
          components: dto.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity ?? 1 })),
        }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'conflict', message: 'A combo with this name already exists' })
      }
      throw error
    }
  }
}
