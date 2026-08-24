// CAP-4 allergen/dietary tag catalog - moved here from CAP-3 menu import per
// the spec amendment (unreliable from OCR/CSV extraction).
import { ConflictException, Injectable } from '@nestjs/common'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { AllergenView, CreateAllergenDto } from './allergens.dtos'
import { isUniqueViolation } from './menu-errors'
import { setTenantContext } from './tenant-context'

@Injectable()
export class AllergensService {
  constructor(private readonly registry: RegionRegistryService) {}

  async list(owner: AdminPrincipal): Promise<AllergenView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const allergens = await tx.allergen.findMany({ where: { tenantId: owner.tenantId }, orderBy: { name: 'asc' } })
      return allergens.map((a) => ({ id: a.id, name: a.name }))
    })
  }

  async create(owner: AdminPrincipal, dto: CreateAllergenDto): Promise<AllergenView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    try {
      return await plane.$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        const created = await tx.allergen.create({ data: { tenantId: owner.tenantId, name: dto.name } })
        return { id: created.id, name: created.name }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'conflict', message: 'An allergen tag with this name already exists' })
      }
      throw error
    }
  }
}
