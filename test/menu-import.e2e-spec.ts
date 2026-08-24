// CAP-3 success criteria, end to end: nothing lands in the catalogue until an
// explicit commit, every extracted field is editable in the draft first, the
// edited values (not the original extraction) are what land on commit, the
// commit is atomic, and a successful commit flips the go-live checklist's
// menu_import step.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import ExcelJS from 'exceljs'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'

interface DraftItemBody {
  id: string
  name: string
  shortName: string
  category: string
  priceMinor: number
  currency: string
  confidence: { name: number; shortName: number; category: number; price: number; overall: number }
}

interface DraftBody {
  importId: string
  status: 'draft' | 'committed'
  sourceType: 'csv' | 'xlsx' | 'image' | 'pdf'
  fileName: string
  items: DraftItemBody[]
}

interface CommitBody {
  importId: string
  committedAt: string
  categories: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string; shortName: string; categoryId: string; price: { id: string; priceMinor: number; currency: string } }>
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.invoice.deleteMany()
  await prisma.subscription.deleteMany()
  await prisma.appliedOp.deleteMany()
  await prisma.syncDeadLetter.deleteMany()
  await prisma.device.deleteMany()
  await prisma.enrolmentCode.deleteMany()
  await prisma.menuImportDraft.deleteMany()
  await prisma.itemOutletOverride.deleteMany()
  await prisma.comboComponent.deleteMany()
  await prisma.combo.deleteMany()
  await prisma.itemAllergen.deleteMany()
  await prisma.allergen.deleteMany()
  await prisma.itemModifierGroup.deleteMany()
  await prisma.modifier.deleteMany()
  await prisma.modifierGroup.deleteMany()
  await prisma.itemPrice.deleteMany()
  await prisma.itemVariant.deleteMany()
  await prisma.menuItem.deleteMany()
  await prisma.menuCategory.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

async function createOwner(prisma: PrismaClient, overrides?: { country?: 'IN' | 'AU' }): Promise<{ tenantId: string; token: string }> {
  const tenantId = uuidv7()
  await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: 'Spice Route Hospitality',
      registeredAddress: '1 Test Street',
      contactName: 'Test Contact',
      contactEmail: 'contact@test.example',
      contactPhone: '+91 90000 00000',
      country: overrides?.country ?? 'IN',
      status: 'provisioning',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  const token = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@spiceroute.example' })
  return { tenantId, token }
}

function csvBuffer(rows: ReadonlyArray<ReadonlyArray<string>>): Buffer {
  return Buffer.from(rows.map((row) => row.join(',')).join('\n'), 'utf8')
}

async function xlsxBuffer(rows: ReadonlyArray<ReadonlyArray<string>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Menu')
  for (const row of rows) sheet.addRow(row)
  const data = await workbook.xlsx.writeBuffer()
  return Buffer.from(data)
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function pngBuffer(): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from('not-a-real-image-body')])
}
function pdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n%not a real pdf body')
}

const SAMPLE_CSV_ROWS = [
  ['Name', 'Category', 'Short Name', 'Price'],
  ['Butter Chicken', 'Mains', 'Btr Chkn', '320.00'],
  ['Garden Salad', 'Starters', '', '150'],
]

describe('/admin/v1/menu-import (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
  })

  async function upload(token: string, buffer: Buffer, filename: string): Promise<request.Response> {
    return request(httpServer).post('/admin/v1/menu-import/upload').set('Authorization', `Bearer ${token}`).attach('file', buffer, filename)
  }

  describe('POST /admin/v1/menu-import/upload', () => {
    it('parses a real CSV into a draft with per-field confidence, and persists nothing to the catalogue', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const res = await upload(token, csvBuffer(SAMPLE_CSV_ROWS), 'menu.csv')

      expect(res.status).toBe(201)
      const body = res.body as DraftBody
      expect(body.status).toBe('draft')
      expect(body.sourceType).toBe('csv')
      expect(body.items).toHaveLength(2)

      const chicken = body.items.find((i) => i.name === 'Butter Chicken')
      expect(chicken?.category).toBe('Mains')
      expect(chicken?.shortName).toBe('Btr Chkn')
      expect(chicken?.priceMinor).toBe(32000)
      expect(chicken?.currency).toBe('INR')
      expect(chicken?.confidence.name).toBe(1)
      expect(chicken?.confidence.shortName).toBe(1)
      expect(chicken?.confidence.price).toBe(1)

      // Second row has no short name column value - derived, lower confidence.
      const salad = body.items.find((i) => i.name === 'Garden Salad')
      expect(salad?.shortName).toBeTruthy()
      expect(salad?.confidence.shortName).toBeLessThan(1)
      expect(salad?.priceMinor).toBe(15000)

      // Draft-only: nothing touches the real catalogue before commit.
      expect(await prisma.menuCategory.count({ where: { tenantId } })).toBe(0)
      expect(await prisma.menuItem.count({ where: { tenantId } })).toBe(0)
      expect(await prisma.itemPrice.count({ where: { tenantId } })).toBe(0)

      const draft = await prisma.menuImportDraft.findUnique({ where: { id: body.importId } })
      expect(draft?.status).toBe('draft')
      expect(draft?.tenantId).toBe(tenantId)
    })

    it('parses a real XLSX workbook', async () => {
      const { token } = await createOwner(prisma, { country: 'AU' })
      const buffer = await xlsxBuffer(SAMPLE_CSV_ROWS)
      const res = await upload(token, buffer, 'menu.xlsx')

      expect(res.status).toBe(201)
      const body = res.body as DraftBody
      expect(body.sourceType).toBe('xlsx')
      expect(body.items).toHaveLength(2)
      expect(body.items.every((i) => i.currency === 'AUD')).toBe(true)
      expect(body.items.find((i) => i.name === 'Butter Chicken')?.priceMinor).toBe(32000)
    })

    it('returns a fixed, lower-confidence stub draft for an image source, and does not fail the upload', async () => {
      const { token } = await createOwner(prisma)
      const res = await upload(token, pngBuffer(), 'scan.png')

      expect(res.status).toBe(201)
      const body = res.body as DraftBody
      expect(body.sourceType).toBe('image')
      expect(body.items.length).toBeGreaterThan(0)
      expect(body.items.every((i) => i.confidence.overall < 1)).toBe(true)
    })

    it('returns a fixed stub draft for a PDF source', async () => {
      const { token } = await createOwner(prisma)
      const res = await upload(token, pdfBuffer(), 'scan.pdf')
      expect(res.status).toBe(201)
      expect((res.body as DraftBody).sourceType).toBe('pdf')
    })

    it('rejects an unsupported file type', async () => {
      const { token } = await createOwner(prisma)
      const res = await upload(token, Buffer.from('hello'), 'menu.txt')
      expect(res.status).toBe(400)
      expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed')
    })

    it('rejects a file whose bytes do not match its declared extension', async () => {
      const { token } = await createOwner(prisma)
      const res = await upload(token, Buffer.from('not actually a png'), 'scan.png')
      expect(res.status).toBe(400)
    })

    it('rejects an upload without a file', async () => {
      const { token } = await createOwner(prisma)
      const res = await request(httpServer).post('/admin/v1/menu-import/upload').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(400)
    })

    it('requires an admin session', async () => {
      const res = await request(httpServer).post('/admin/v1/menu-import/upload').attach('file', csvBuffer(SAMPLE_CSV_ROWS), 'menu.csv')
      expect(res.status).toBe(401)
    })
  })

  describe('PATCH /admin/v1/menu-import/:importId', () => {
    async function draftFor(token: string): Promise<DraftBody> {
      const res = await upload(token, csvBuffer(SAMPLE_CSV_ROWS), 'menu.csv')
      return res.body as DraftBody
    }

    it('edits a field before commit and bumps that field to full confidence', async () => {
      const { token } = await createOwner(prisma)
      const draft = await draftFor(token)
      const chicken = draft.items.find((i) => i.name === 'Butter Chicken')
      expect(chicken).toBeDefined()

      const res = await request(httpServer)
        .patch(`/admin/v1/menu-import/${draft.importId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ id: chicken?.id, name: 'Butter Chicken Deluxe', priceMinor: 35000 }] })

      expect(res.status).toBe(200)
      const updated = (res.body as DraftBody).items.find((i) => i.id === chicken?.id)
      expect(updated?.name).toBe('Butter Chicken Deluxe')
      expect(updated?.priceMinor).toBe(35000)
      expect(updated?.confidence.name).toBe(1)
      expect(updated?.confidence.price).toBe(1)

      // Still draft-only.
      expect(await prisma.menuItem.count()).toBe(0)
    })

    it('rejects an edit addressed to an unknown item id', async () => {
      const { token } = await createOwner(prisma)
      const draft = await draftFor(token)
      const res = await request(httpServer)
        .patch(`/admin/v1/menu-import/${draft.importId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ id: uuidv7(), name: 'Nope' }] })
      expect(res.status).toBe(400)
    })

    it('404s for an unknown importId', async () => {
      const { token } = await createOwner(prisma)
      const res = await request(httpServer)
        .patch(`/admin/v1/menu-import/${uuidv7()}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [] })
      expect(res.status).toBe(404)
    })

    it('never leaks a draft across tenants', async () => {
      const owner1 = await createOwner(prisma)
      const owner2 = await createOwner(prisma)
      const draft = await draftFor(owner1.token)
      const res = await request(httpServer)
        .patch(`/admin/v1/menu-import/${draft.importId}`)
        .set('Authorization', `Bearer ${owner2.token}`)
        .send({ items: [] })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /admin/v1/menu-import/:importId/commit', () => {
    it('commits the EDITED draft values, not the original extraction, and flips the checklist step', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const uploadRes = await upload(token, csvBuffer(SAMPLE_CSV_ROWS), 'menu.csv')
      const draft = uploadRes.body as DraftBody
      const chicken = draft.items.find((i) => i.name === 'Butter Chicken')

      await request(httpServer)
        .patch(`/admin/v1/menu-import/${draft.importId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ id: chicken?.id, name: 'Butter Chicken Deluxe', priceMinor: 35000, category: 'Chef Specials' }] })

      const commitRes = await request(httpServer).post(`/admin/v1/menu-import/${draft.importId}/commit`).set('Authorization', `Bearer ${token}`)
      expect(commitRes.status).toBe(201)
      const commit = commitRes.body as CommitBody
      expect(commit.items).toHaveLength(2)
      expect(commit.categories.map((c) => c.name).sort()).toEqual(['Chef Specials', 'Starters'])

      const items = await prisma.menuItem.findMany({ where: { tenantId }, include: { prices: true, category: true } })
      const committedChicken = items.find((i) => i.name === 'Butter Chicken Deluxe')
      expect(committedChicken).toBeDefined()
      expect(committedChicken?.category.name).toBe('Chef Specials')
      expect(committedChicken?.prices).toHaveLength(1)
      expect(committedChicken?.prices[0]?.priceMinor).toBe(35000n)
      // The original, unedited value never lands anywhere.
      expect(items.some((i) => i.name === 'Butter Chicken')).toBe(false)

      const draftRow = await prisma.menuImportDraft.findUnique({ where: { id: draft.importId } })
      expect(draftRow?.status).toBe('committed')
      expect(draftRow?.committedAt).not.toBeNull()

      const checklist = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${token}`)
      const step = (checklist.body as { steps: Array<{ step: string; completed: boolean }> }).steps.find((s) => s.step === 'menu_import')
      expect(step?.completed).toBe(true)

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'menu.imported' } })
      expect(audit).toHaveLength(1)
    })

    it('is atomic: a draft with a duplicate item name in one category rolls back completely', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const rows = [
        ['Name', 'Category', 'Price'],
        ['Butter Chicken', 'Mains', '300'],
        ['Butter Chicken', 'Mains', '310'],
      ]
      const uploadRes = await upload(token, csvBuffer(rows), 'menu.csv')
      const draft = uploadRes.body as DraftBody
      expect(draft.items).toHaveLength(2)

      const before = {
        categories: await prisma.menuCategory.count(),
        items: await prisma.menuItem.count(),
        prices: await prisma.itemPrice.count(),
        audit: await prisma.auditEvent.count(),
      }

      const commitRes = await request(httpServer).post(`/admin/v1/menu-import/${draft.importId}/commit`).set('Authorization', `Bearer ${token}`)
      expect(commitRes.status).toBe(409)

      expect(await prisma.menuCategory.count()).toBe(before.categories)
      expect(await prisma.menuItem.count()).toBe(before.items)
      expect(await prisma.itemPrice.count()).toBe(before.prices)
      expect(await prisma.auditEvent.count()).toBe(before.audit)

      const draftRow = await prisma.menuImportDraft.findUnique({ where: { id: draft.importId } })
      expect(draftRow?.status).toBe('draft')

      const checklist = await request(httpServer).get('/admin/v1/checklist').set('Authorization', `Bearer ${token}`)
      const step = (checklist.body as { steps: Array<{ step: string; completed: boolean }> }).steps.find((s) => s.step === 'menu_import')
      expect(step?.completed).toBe(false)
      expect(tenantId).toBeTruthy()
    })

    it('rejects committing the same draft twice', async () => {
      const { token } = await createOwner(prisma)
      const uploadRes = await upload(token, csvBuffer(SAMPLE_CSV_ROWS), 'menu.csv')
      const draft = uploadRes.body as DraftBody

      const first = await request(httpServer).post(`/admin/v1/menu-import/${draft.importId}/commit`).set('Authorization', `Bearer ${token}`)
      expect(first.status).toBe(201)

      const second = await request(httpServer).post(`/admin/v1/menu-import/${draft.importId}/commit`).set('Authorization', `Bearer ${token}`)
      expect(second.status).toBe(409)
      expect((second.body as { error: { code: string } }).error.code).toBe('already_committed')
    })

    it('404s for an unknown importId', async () => {
      const { token } = await createOwner(prisma)
      const res = await request(httpServer).post(`/admin/v1/menu-import/${uuidv7()}/commit`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(404)
    })

    it('reuses an existing category by name instead of creating a duplicate on a second import', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const first = await upload(token, csvBuffer(SAMPLE_CSV_ROWS), 'menu.csv')
      await request(httpServer).post(`/admin/v1/menu-import/${(first.body as DraftBody).importId}/commit`).set('Authorization', `Bearer ${token}`)

      const second = await upload(token, csvBuffer([['Name', 'Category', 'Price'], ['Chicken Tikka', 'Mains', '280']]), 'menu2.csv')
      await request(httpServer).post(`/admin/v1/menu-import/${(second.body as DraftBody).importId}/commit`).set('Authorization', `Bearer ${token}`)

      const mainsCategories = await prisma.menuCategory.findMany({ where: { tenantId, name: 'Mains' } })
      expect(mainsCategories).toHaveLength(1)
      expect(await prisma.menuItem.count({ where: { tenantId, categoryId: mainsCategories[0]?.id } })).toBe(2)
    })
  })
})
