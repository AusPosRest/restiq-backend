// restiq-backend#160 combos: a flat-priced bundle built from slots. Not
// versioned (AD-11 binds item_prices, not combos). Orders snapshot the combo
// price on their own lines, so editing or archiving a combo never changes a
// placed order.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { COMBO_INCLUDE, listMenuCombos, toComboMenuView } from './combo-menu'
import { ComboView, SaveComboDto } from './combos.dtos'
import { isUniqueViolation } from './menu-errors'
import { setTenantContext } from './tenant-context'

type Tx = Prisma.TransactionClient

// Owner view: tenant-wide availability (no outlet overrides).
const tenantWide = (item: { available: boolean }) => item.available

async function assertRefsBelongToTenant(tx: Tx, tenantId: string, dto: SaveComboDto): Promise<void> {
  if (dto.categoryId) {
    const category = await tx.menuCategory.findUnique({ where: { id: dto.categoryId } })
    if (!category || category.tenantId !== tenantId) {
      throw new BadRequestException({ code: 'validation_failed', message: 'No such category' })
    }
  }
  const options = dto.slots.flatMap((s) => s.options)
  const items = await tx.menuItem.findMany({ where: { tenantId, id: { in: options.map((o) => o.itemId) } }, include: { variants: true } })
  const byId = new Map(items.map((i) => [i.id, i]))
  for (const option of options) {
    const item = byId.get(option.itemId)
    if (!item) throw new BadRequestException({ code: 'validation_failed', message: `No such item: ${option.itemId}` })
    if (option.variantId && !item.variants.some((v) => v.id === option.variantId)) {
      throw new BadRequestException({ code: 'validation_failed', message: `That size does not belong to ${item.name}` })
    }
  }
}

async function writeSlots(tx: Tx, tenantId: string, comboId: string, dto: SaveComboDto): Promise<void> {
  for (const [i, slot] of dto.slots.entries()) {
    const created = await tx.comboSlot.create({ data: { tenantId, comboId, name: slot.name, pickCount: slot.pickCount, sortOrder: i } })
    for (const [j, option] of slot.options.entries()) {
      await tx.comboSlotOption.create({
        data: { tenantId, slotId: created.id, itemId: option.itemId, variantId: option.variantId ?? null, upchargeMinor: BigInt(option.upchargeMinor ?? 0), sortOrder: j },
      })
    }
  }
}

async function loadLiveCombo(tx: Tx, tenantId: string, comboId: string) {
  const combo = await tx.combo.findUnique({ where: { id: comboId } })
  if (!combo || combo.tenantId !== tenantId || combo.archivedAt) {
    throw new NotFoundException({ code: 'not_found', message: 'No such combo' })
  }
  return combo
}

async function view(tx: Tx, comboId: string): Promise<ComboView> {
  return toComboMenuView(await tx.combo.findUniqueOrThrow({ where: { id: comboId }, include: COMBO_INCLUDE }), tenantWide)
}

function rethrowNameClash(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ConflictException({ code: 'conflict', message: 'A combo with this name already exists' })
  }
  throw error
}

@Injectable()
export class CombosService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  async list(owner: AdminPrincipal): Promise<ComboView[]> {
    return this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      return listMenuCombos(tx, owner.tenantId, null)
    })
  }

  async create(owner: AdminPrincipal, dto: SaveComboDto): Promise<ComboView> {
    try {
      return await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        await assertRefsBelongToTenant(tx, owner.tenantId, dto)
        const combo = await tx.combo.create({
          data: {
            tenantId: owner.tenantId,
            name: dto.name,
            categoryId: dto.categoryId ?? null,
            priceMinor: BigInt(dto.priceMinor),
            currency: dto.currency,
            photoUrl: dto.photoUrl ?? null,
            available: dto.available ?? true,
          },
        })
        await writeSlots(tx, owner.tenantId, combo.id, dto)
        return view(tx, combo.id)
      })
    } catch (error) {
      rethrowNameClash(error)
    }
  }

  /** Replaces the combo's fields and every slot. Past orders keep their own snapshot. */
  async update(owner: AdminPrincipal, comboId: string, dto: SaveComboDto): Promise<ComboView> {
    try {
      return await this.plane().$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        await loadLiveCombo(tx, owner.tenantId, comboId)
        await assertRefsBelongToTenant(tx, owner.tenantId, dto)
        await tx.combo.update({
          where: { id: comboId },
          data: {
            name: dto.name,
            categoryId: dto.categoryId ?? null,
            priceMinor: BigInt(dto.priceMinor),
            currency: dto.currency,
            photoUrl: dto.photoUrl ?? null,
            available: dto.available ?? true,
          },
        })
        await tx.comboSlot.deleteMany({ where: { comboId } })
        await writeSlots(tx, owner.tenantId, comboId, dto)
        // Slots were rebuilt, so picks in unplaced guest carts no longer match.
        await tx.cartLine.deleteMany({ where: { tenantId: owner.tenantId, comboId } })
        return view(tx, comboId)
      })
    } catch (error) {
      rethrowNameClash(error)
    }
  }

  /** Delete = archive: the row stays for order and cart lines that point at it. */
  async archive(owner: AdminPrincipal, comboId: string): Promise<void> {
    await this.plane().$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      await loadLiveCombo(tx, owner.tenantId, comboId)
      await tx.combo.update({ where: { id: comboId }, data: { archivedAt: new Date() } })
      // An unplaced guest cart can't keep a combo that no longer exists.
      await tx.cartLine.deleteMany({ where: { tenantId: owner.tenantId, comboId } })
    })
  }
}
