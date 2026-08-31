// CAP-4 modifier groups. Structural validation (0 <= min <= max) happens
// here at write time, on the resolved final values - both on create and on a
// partial update, so a two-step edit (set max first, then min) can never
// leave the row in an invalid state even transiently.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { isUniqueViolation } from './menu-errors'
import { CreateModifierDto, CreateModifierGroupDto, ModifierGroupView, UpdateModifierGroupDto } from './modifier-groups.dtos'
import { setTenantContext } from './tenant-context'

function assertValidBounds(minSelections: number, maxSelections: number): void {
  if (minSelections > maxSelections) {
    throw new BadRequestException({ code: 'validation_failed', message: 'minSelections must be less than or equal to maxSelections' })
  }
}

@Injectable()
export class ModifierGroupsService {
  constructor(private readonly registry: RegionRegistryService) {}

  async list(owner: AdminPrincipal): Promise<ModifierGroupView[]> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const groups = await tx.modifierGroup.findMany({
        where: { tenantId: owner.tenantId },
        include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { name: 'asc' },
      })
      return groups.map(toView)
    })
  }

  async create(owner: AdminPrincipal, dto: CreateModifierGroupDto): Promise<ModifierGroupView> {
    assertValidBounds(dto.minSelections, dto.maxSelections)
    const plane = this.registry.planeFor(this.registry.homeRegion())
    try {
      return await plane.$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        const group = await tx.modifierGroup.create({
          data: { tenantId: owner.tenantId, name: dto.name, minSelections: dto.minSelections, maxSelections: dto.maxSelections },
        })
        const modifiers = await createModifiers(tx, owner.tenantId, group.id, dto.modifiers ?? [])
        return { id: group.id, name: group.name, minSelections: group.minSelections, maxSelections: group.maxSelections, modifiers }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'conflict', message: 'A modifier group with this name already exists' })
      }
      throw error
    }
  }

  async update(owner: AdminPrincipal, groupId: string, dto: UpdateModifierGroupDto): Promise<ModifierGroupView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const existing = await tx.modifierGroup.findUnique({ where: { id: groupId }, include: { modifiers: true } })
      if (!existing || existing.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such modifier group' })
      }
      const minSelections = dto.minSelections ?? existing.minSelections
      const maxSelections = dto.maxSelections ?? existing.maxSelections
      assertValidBounds(minSelections, maxSelections)

      const updated = await tx.modifierGroup.update({
        where: { id: groupId },
        data: { name: dto.name ?? existing.name, minSelections, maxSelections },
      })
      return {
        id: updated.id,
        name: updated.name,
        minSelections: updated.minSelections,
        maxSelections: updated.maxSelections,
        modifiers: existing.modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.priceMinor) })),
      }
    })
  }

  async addModifier(owner: AdminPrincipal, groupId: string, dto: CreateModifierDto): Promise<ModifierGroupView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const group = await tx.modifierGroup.findUnique({ where: { id: groupId }, include: { modifiers: true } })
      if (!group || group.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such modifier group' })
      }
      await tx.modifier.create({
        data: { tenantId: owner.tenantId, groupId, name: dto.name, priceMinor: BigInt(dto.priceMinor ?? 0), sortOrder: group.modifiers.length },
      })
      const modifiers = await tx.modifier.findMany({ where: { groupId }, orderBy: { sortOrder: 'asc' } })
      return {
        id: group.id,
        name: group.name,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        modifiers: modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.priceMinor) })),
      }
    })
  }
}

async function createModifiers(
  tx: Prisma.TransactionClient,
  tenantId: string,
  groupId: string,
  modifiers: CreateModifierDto[],
): Promise<{ id: string; name: string; priceMinor: number }[]> {
  const created: { id: string; name: string; priceMinor: number }[] = []
  for (let i = 0; i < modifiers.length; i++) {
    const m = modifiers[i]
    if (!m) continue
    const row = await tx.modifier.create({ data: { tenantId, groupId, name: m.name, priceMinor: BigInt(m.priceMinor ?? 0), sortOrder: i } })
    created.push({ id: row.id, name: row.name, priceMinor: Number(row.priceMinor) })
  }
  return created
}

function toView(group: {
  id: string
  name: string
  minSelections: number
  maxSelections: number
  modifiers: { id: string; name: string; priceMinor: bigint }[]
}): ModifierGroupView {
  return {
    id: group.id,
    name: group.name,
    minSelections: group.minSelections,
    maxSelections: group.maxSelections,
    modifiers: group.modifiers.map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.priceMinor) })),
  }
}
