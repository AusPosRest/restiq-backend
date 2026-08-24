// CAP-3: upload -> draft -> review/edit -> commit. Nothing lands in the real
// catalogue (menu_categories/menu_items/item_prices) until commit; the draft
// in between is a real row (menu_import_drafts), not per-instance memory, so
// it survives a reload and works across app instances.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { ChecklistService } from '../checklist/checklist.service'
import { DraftItem, extractDraftItems, MenuImportSourceType } from './extraction'
import { DraftItemView, MenuImportCommitResult, MenuImportDraftView, PatchDraftItemDto } from './menu-import.dtos'
import { resolveSourceType } from './upload-validation'

interface UploadedFile {
  originalname: string
  buffer: Buffer
  size: number
}

interface DraftPayload {
  items: DraftItem[]
}

async function setTenantContext(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}

function currencyForCountry(country: string): string {
  return country === 'IN' ? 'INR' : 'AUD'
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function toJson(payload: DraftPayload): Prisma.InputJsonValue {
  return payload as unknown as Prisma.InputJsonValue
}

function toView(draft: { id: string; status: string; sourceType: string; fileName: string; payload: unknown }): MenuImportDraftView {
  const payload = draft.payload as DraftPayload
  const items: DraftItemView[] = payload.items.map((item) => ({ ...item }))
  return {
    importId: draft.id,
    status: draft.status as 'draft' | 'committed',
    sourceType: draft.sourceType as MenuImportSourceType,
    fileName: draft.fileName,
    items,
  }
}

function applyEdit(item: DraftItem, edit: PatchDraftItemDto): void {
  if (edit.name !== undefined) {
    item.name = edit.name
    item.confidence.name = 1
  }
  if (edit.shortName !== undefined) {
    item.shortName = edit.shortName
    item.confidence.shortName = 1
  }
  if (edit.category !== undefined) {
    item.category = edit.category
    item.confidence.category = 1
  }
  if (edit.priceMinor !== undefined) {
    item.priceMinor = edit.priceMinor
    item.confidence.price = 1
  }
  if (edit.currency !== undefined) {
    item.currency = edit.currency
  }
  item.confidence.overall = round2((item.confidence.name + item.confidence.shortName + item.confidence.category + item.confidence.price) / 4)
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

@Injectable()
export class MenuImportService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly checklist: ChecklistService,
  ) {}

  async upload(owner: AdminPrincipal, file: UploadedFile): Promise<MenuImportDraftView> {
    const sourceType = resolveSourceType(file)
    const plane = this.registry.planeFor(this.registry.homeRegion())

    const tenant = await plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      return tx.tenant.findUnique({ where: { id: owner.tenantId }, select: { country: true } })
    })
    if (!tenant) throw new NotFoundException({ code: 'not_found', message: 'No such tenant' })

    // Parsing (XLSX especially) is CPU-bound - kept outside any transaction
    // so a DB connection isn't held for the duration (same reasoning as
    // hashing outside the accept-invite transaction).
    const items = await extractDraftItems(sourceType, file.buffer, currencyForCountry(tenant.country))

    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const draft = await tx.menuImportDraft.create({
        data: { tenantId: owner.tenantId, sourceType, fileName: file.originalname, payload: toJson({ items }) },
      })
      return toView(draft)
    })
  }

  async patch(owner: AdminPrincipal, importId: string, edits: PatchDraftItemDto[]): Promise<MenuImportDraftView> {
    const plane = this.registry.planeFor(this.registry.homeRegion())

    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const draft = await tx.menuImportDraft.findUnique({ where: { id: importId } })
      if (!draft || draft.tenantId !== owner.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such menu import draft' })
      }
      if (draft.status !== 'draft') {
        throw new ConflictException({ code: 'already_committed', message: 'This import has already been committed' })
      }

      const payload = draft.payload as unknown as DraftPayload
      const byId = new Map(payload.items.map((item) => [item.id, item]))
      for (const edit of edits) {
        const item = byId.get(edit.id)
        if (!item) {
          throw new BadRequestException({ code: 'validation_failed', message: `No draft item with id ${edit.id}` })
        }
        applyEdit(item, edit)
      }

      const updated = await tx.menuImportDraft.update({
        where: { id: importId },
        data: { payload: toJson({ items: [...byId.values()] }) },
      })
      return toView(updated)
    })
  }

  async commit(owner: AdminPrincipal, importId: string): Promise<MenuImportCommitResult> {
    const plane = this.registry.planeFor(this.registry.homeRegion())

    let result: MenuImportCommitResult
    try {
      result = await plane.$transaction(async (tx) => {
        await setTenantContext(tx, owner.tenantId)
        const draft = await tx.menuImportDraft.findUnique({ where: { id: importId } })
        if (!draft || draft.tenantId !== owner.tenantId) {
          throw new NotFoundException({ code: 'not_found', message: 'No such menu import draft' })
        }
        if (draft.status !== 'draft') {
          throw new ConflictException({ code: 'already_committed', message: 'This import has already been committed' })
        }

        const payload = draft.payload as unknown as DraftPayload
        if (payload.items.length === 0) {
          throw new BadRequestException({ code: 'validation_failed', message: 'This import has no items to commit' })
        }

        const existingCategories = await tx.menuCategory.findMany({ where: { tenantId: owner.tenantId } })
        const categoriesByName = new Map(existingCategories.map((category) => [category.name.toLowerCase(), { id: category.id }]))
        let nextSortOrder = existingCategories.length

        const createdCategories: MenuImportCommitResult['categories'] = []
        const createdItems: MenuImportCommitResult['items'] = []

        for (const draftItem of payload.items) {
          const key = draftItem.category.toLowerCase()
          let category = categoriesByName.get(key)
          if (!category) {
            nextSortOrder += 1
            const created = await tx.menuCategory.create({ data: { tenantId: owner.tenantId, name: draftItem.category, sortOrder: nextSortOrder } })
            category = { id: created.id }
            categoriesByName.set(key, category)
            createdCategories.push({ id: created.id, name: draftItem.category })
          }

          // AD-11: the item's first price is still an insert, never an UPDATE.
          const item = await tx.menuItem.create({
            data: { tenantId: owner.tenantId, categoryId: category.id, name: draftItem.name, shortName: draftItem.shortName },
          })
          const price = await tx.itemPrice.create({
            data: { tenantId: owner.tenantId, itemId: item.id, priceMinor: BigInt(draftItem.priceMinor), currency: draftItem.currency },
          })
          createdItems.push({
            id: item.id,
            name: item.name,
            shortName: item.shortName,
            categoryId: category.id,
            price: { id: price.id, priceMinor: draftItem.priceMinor, currency: price.currency },
          })
        }

        await tx.auditEvent.create({
          data: {
            tenantId: owner.tenantId,
            actorId: owner.id,
            actorEmail: owner.email,
            action: 'menu.imported',
            reason: `Committed menu import (${createdItems.length} item(s)) from ${draft.fileName}`,
            occurredAt: new Date(),
          },
        })

        const committedAt = new Date()
        await tx.menuImportDraft.update({ where: { id: importId }, data: { status: 'committed', committedAt } })

        return { importId, committedAt: committedAt.toISOString(), categories: createdCategories, items: createdItems }
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'conflict',
          message: 'This import has duplicate item names within a category - fix the draft and try again',
        })
      }
      throw error
    }

    // Reuses story 1's checklist service directly - no re-implementation, no
    // HTTP self-call. This call is intentionally outside the transaction
    // above: Prisma's interactive transactions don't compose across separate
    // $transaction calls, and this story's atomicity guarantee is scoped to
    // the catalogue write + draft resolution, not the checklist flag.
    await this.checklist.updateStep(owner.tenantId, 'menu_import', true)

    return result
  }
}
