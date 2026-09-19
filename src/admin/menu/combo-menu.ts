// restiq-backend#160: the one place combos are read for selling and a
// selection is checked. POS order lines, the guest cart and the owner API
// all go through here, so availability and "pick N" rules can't drift.
import { BadRequestException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'

type Tx = Prisma.TransactionClient

export const COMBO_INCLUDE = {
  slots: {
    orderBy: { sortOrder: 'asc' },
    include: { options: { orderBy: { sortOrder: 'asc' }, include: { item: true, variant: true } } },
  },
} satisfies Prisma.ComboInclude

export type ComboWithSlots = Prisma.ComboGetPayload<{ include: typeof COMBO_INCLUDE }>

export interface ComboOptionView {
  id: string
  itemId: string
  itemName: string
  variantId: string | null
  variantName: string | null
  upchargeMinor: number
  available: boolean
}

export interface ComboSlotView {
  id: string
  name: string
  pickCount: number
  options: ComboOptionView[]
}

export interface ComboMenuView {
  id: string
  categoryId: string | null
  name: string
  photoUrl: string | null
  priceMinor: number
  currency: string
  /** False when the owner switched it off, or a slot has no available option left. */
  available: boolean
  slots: ComboSlotView[]
}

/** Item availability at an outlet: the outlet override wins over the tenant-wide 86 toggle. */
async function itemAvailability(tx: Tx, tenantId: string, outletId: string | null): Promise<(item: { id: string; available: boolean }) => boolean> {
  const overrides = outletId ? await tx.itemOutletOverride.findMany({ where: { tenantId, outletId } }) : []
  const byItem = new Map(overrides.map((o) => [o.itemId, o.available]))
  return (item) => byItem.get(item.id) ?? item.available
}

export function toComboMenuView(combo: ComboWithSlots, isAvailable: (item: { id: string; available: boolean }) => boolean): ComboMenuView {
  const slots = combo.slots.map((slot) => ({
    id: slot.id,
    name: slot.name,
    pickCount: slot.pickCount,
    options: slot.options.map((o) => ({
      id: o.id,
      itemId: o.itemId,
      itemName: o.item.name,
      variantId: o.variantId,
      variantName: o.variant?.name ?? null,
      upchargeMinor: Number(o.upchargeMinor),
      available: isAvailable(o.item),
    })),
  }))
  return {
    id: combo.id,
    categoryId: combo.categoryId,
    name: combo.name,
    photoUrl: combo.photoUrl,
    priceMinor: Number(combo.priceMinor),
    currency: combo.currency,
    available: combo.available && slots.length > 0 && slots.every((s) => s.options.some((o) => o.available)),
    slots,
  }
}

/** Every live combo for a menu (POS, QR, kiosk), with availability at this outlet. Pass outletId null for tenant-wide (owner console). */
export async function listMenuCombos(tx: Tx, tenantId: string, outletId: string | null): Promise<ComboMenuView[]> {
  const [combos, isAvailable] = await Promise.all([
    tx.combo.findMany({ where: { tenantId, archivedAt: null }, include: COMBO_INCLUDE, orderBy: { name: 'asc' } }),
    itemAvailability(tx, tenantId, outletId),
  ])
  return combos.map((c) => toComboMenuView(c, isAvailable))
}

export interface ComboSelectionInput {
  /** A ComboSlotOption id - identifies the slot, item and variant. */
  optionId: string
  quantity?: number
  modifierIds?: string[]
}

export interface ResolvedComboChild {
  optionId: string
  itemId: string
  itemName: string
  variantId: string | null
  stationId: string | null
  /** Per one combo; multiply by the combo quantity for the line. */
  quantity: number
  upchargeMinor: bigint
  modifierIds: string[]
}

type ItemGroups = Prisma.MenuItemGetPayload<{ include: { modifierGroups: { include: { group: { include: { modifiers: true } } } } } }>

/** Same min/max rule order lines and cart lines apply to a single item. */
export function assertComboModifiersValid(item: ItemGroups, modifierIds: string[]): void {
  const valid = new Set(item.modifierGroups.flatMap((link) => link.group.modifiers.map((m) => m.id)))
  if (modifierIds.some((id) => !valid.has(id))) {
    throw new BadRequestException({ code: 'validation_failed', message: `One or more modifiers do not belong to ${item.name}` })
  }
  for (const { group } of item.modifierGroups) {
    const n = group.modifiers.filter((m) => modifierIds.includes(m.id)).length
    if (n < group.minSelections || n > group.maxSelections) {
      throw new BadRequestException({
        code: 'modifier_selection_invalid',
        message: `"${group.name}" on ${item.name} requires between ${group.minSelections} and ${group.maxSelections} selection(s), got ${n}`,
      })
    }
  }
}

/**
 * Checks a combo pick against its slots and returns the child lines to write.
 * A fixed slot (one option) may be left out and is filled in; every other slot
 * must add up to exactly its pickCount. Unavailable combos or items are refused.
 */
export async function resolveComboSelection(
  tx: Tx,
  tenantId: string,
  outletId: string,
  comboId: string,
  selections: ComboSelectionInput[],
): Promise<{ combo: ComboWithSlots; children: ResolvedComboChild[] }> {
  const combo = await tx.combo.findUnique({ where: { id: comboId }, include: COMBO_INCLUDE })
  if (!combo || combo.tenantId !== tenantId || combo.archivedAt) {
    throw new BadRequestException({ code: 'validation_failed', message: 'No such combo' })
  }
  const isAvailable = await itemAvailability(tx, tenantId, outletId)
  if (!toComboMenuView(combo, isAvailable).available) {
    throw new BadRequestException({ code: 'item_unavailable', message: `${combo.name} is currently unavailable` })
  }

  const optionById = new Map(combo.slots.flatMap((slot) => slot.options.map((option) => [option.id, { slot, option }] as const)))
  const picks = selections.map((s) => {
    const found = optionById.get(s.optionId)
    if (!found) throw new BadRequestException({ code: 'validation_failed', message: `That choice is not part of ${combo.name}` })
    return { ...found, quantity: s.quantity ?? 1, modifierIds: s.modifierIds ?? [] }
  })
  for (const slot of combo.slots) {
    if (slot.options.length === 1 && !picks.some((p) => p.slot.id === slot.id)) {
      picks.push({ slot, option: slot.options[0], quantity: slot.pickCount, modifierIds: [] })
    }
    const count = picks.filter((p) => p.slot.id === slot.id).reduce((sum, p) => sum + p.quantity, 0)
    if (count !== slot.pickCount) {
      throw new BadRequestException({ code: 'combo_selection_invalid', message: `"${slot.name}" needs ${slot.pickCount} choice(s), got ${count}` })
    }
  }

  const children: ResolvedComboChild[] = []
  for (const pick of picks) {
    if (!isAvailable(pick.option.item)) {
      throw new BadRequestException({ code: 'item_unavailable', message: `${pick.option.item.name} is currently unavailable` })
    }
    const item = await tx.menuItem.findUniqueOrThrow({
      where: { id: pick.option.itemId },
      include: { modifierGroups: { include: { group: { include: { modifiers: true } } } } },
    })
    assertComboModifiersValid(item, pick.modifierIds)
    children.push({
      optionId: pick.option.id,
      itemId: pick.option.itemId,
      itemName: item.name,
      variantId: pick.option.variantId,
      stationId: item.stationId,
      quantity: pick.quantity,
      upchargeMinor: pick.option.upchargeMinor,
      modifierIds: pick.modifierIds,
    })
  }
  return { combo, children }
}
