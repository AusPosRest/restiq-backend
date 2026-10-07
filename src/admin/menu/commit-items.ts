// One "land these items in a tenant's menu" implementation, shared by the
// menu-import commit (CAP-3) and the product-directory import (#153):
// find-or-create the category by name, insert the item, insert its first
// price (AD-11: a price is always an insert, never an UPDATE).
import type { Prisma, VegMarker } from '../../generated/prisma/client'

export interface CommitItemInput {
  name: string
  shortName: string
  category: string
  priceMinor: number
  currency: string
  photoUrl?: string | null
  nameHindi?: string | null
  vegMarker?: VegMarker | null
}

export interface CommittedItem {
  id: string
  name: string
  shortName: string
  categoryId: string
  price: { id: string; priceMinor: number; currency: string }
}

export interface CommitItemsResult {
  categories: Array<{ id: string; name: string }>
  items: CommittedItem[]
}

export function currencyForCountry(country: string): string {
  return country === 'IN' ? 'INR' : 'AUD'
}

export async function commitItems(tx: Prisma.TransactionClient, tenantId: string, inputs: CommitItemInput[]): Promise<CommitItemsResult> {
  const existingCategories = await tx.menuCategory.findMany({ where: { tenantId } })
  const categoriesByName = new Map(existingCategories.map((category) => [category.name.toLowerCase(), { id: category.id }]))
  let nextSortOrder = existingCategories.length

  const categories: CommitItemsResult['categories'] = []
  const items: CommittedItem[] = []

  for (const input of inputs) {
    const key = input.category.toLowerCase()
    let category = categoriesByName.get(key)
    if (!category) {
      nextSortOrder += 1
      const created = await tx.menuCategory.create({ data: { tenantId, name: input.category, sortOrder: nextSortOrder } })
      category = { id: created.id }
      categoriesByName.set(key, category)
      categories.push({ id: created.id, name: input.category })
    }

    const item = await tx.menuItem.create({
      data: {
        tenantId,
        categoryId: category.id,
        name: input.name,
        shortName: input.shortName,
        photoUrl: input.photoUrl ?? null,
        nameHindi: input.nameHindi ?? null,
        vegMarker: input.vegMarker ?? null,
      },
    })
    const price = await tx.itemPrice.create({
      data: { tenantId, itemId: item.id, priceMinor: BigInt(input.priceMinor), currency: input.currency },
    })
    items.push({
      id: item.id,
      name: item.name,
      shortName: item.shortName,
      categoryId: category.id,
      price: { id: price.id, priceMinor: input.priceMinor, currency: price.currency },
    })
  }

  return { categories, items }
}
