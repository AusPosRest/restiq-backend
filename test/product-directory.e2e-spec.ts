// Product directory (#153): operators curate a platform-wide list, an owner
// searches it by name/tag, and an import lands copies in that tenant's menu
// only - editable there without touching the directory or other tenants.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, uuidv7 } from '../src/platform'

const OPERATOR_EMAIL = 'catalog-operator@restiq.example'

interface Product {
  id: string
  name: string
  shortName: string
  category: string
  suggestedPriceMinor: number
  currency: string
  tags: string[]
  vegMarker: 'veg' | 'non_veg' | null
}
interface ImportBody {
  categories: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string; categoryId: string; price: { priceMinor: number; currency: string } }>
}

async function createOwner(prisma: PrismaClient, country: 'IN' | 'AU'): Promise<{ tenantId: string; token: string }> {
  const tenantId = uuidv7()
  await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: `Tenant ${country}`,
      registeredAddress: '1 Test Street',
      contactName: 'Test Contact',
      contactEmail: `${tenantId}@test.example`,
      contactPhone: '+91 90000 00000',
      country,
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  return { tenantId, token: signAdminToken({ id: uuidv7(), tenantId, email: `owner-${tenantId}@test.example` }) }
}

const PANEER = { name: 'Paneer Tikka', shortName: 'Pnr Tikka', category: 'Starters', suggestedPriceMinor: 24900, currency: 'INR', vegMarker: 'veg', tags: ['Veg', 'north-indian', ' grill '] }
const CHICKEN = { name: 'Butter Chicken', shortName: 'Btr Chkn', category: 'Mains', suggestedPriceMinor: 32900, currency: 'INR', vegMarker: 'non_veg', tags: ['north-indian'] }
const PIE = { name: 'Meat Pie', shortName: 'Pie', category: 'Mains', suggestedPriceMinor: 1200, currency: 'AUD', tags: ['bakery'] }

describe('product directory (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let opsToken: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await prisma.operatorUser.deleteMany({ where: { email: OPERATOR_EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await prisma.catalogProduct.deleteMany()
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await prisma.catalogProduct.deleteMany()
    await prisma.itemPrice.deleteMany()
    await prisma.menuItem.deleteMany()
    await prisma.menuCategory.deleteMany()
  })

  async function createProduct(body: Record<string, unknown>): Promise<Product> {
    const res = await request(httpServer).post('/ops/v1/catalog/products').set('Authorization', `Bearer ${opsToken}`).send(body).expect(201)
    return (res.body as { product: Product }).product
  }

  it('operators create, search, edit and delete products; tags are normalised', async () => {
    const paneer = await createProduct(PANEER)
    expect(paneer.tags).toEqual(['veg', 'north-indian', 'grill'])
    await createProduct(CHICKEN)
    await createProduct(PIE)

    const all = (await request(httpServer).get('/ops/v1/catalog/products').set('Authorization', `Bearer ${opsToken}`).expect(200)).body as { products: Product[] }
    expect(all.products.map((p) => p.name)).toEqual(['Butter Chicken', 'Meat Pie', 'Paneer Tikka'])

    const byTag = (await request(httpServer).get('/ops/v1/catalog/products?tag=north-indian').set('Authorization', `Bearer ${opsToken}`).expect(200)).body as { products: Product[] }
    expect(byTag.products.map((p) => p.name).sort()).toEqual(['Butter Chicken', 'Paneer Tikka'])

    const byQ = (await request(httpServer).get('/ops/v1/catalog/products?q=pie').set('Authorization', `Bearer ${opsToken}`).expect(200)).body as { products: Product[] }
    expect(byQ.products.map((p) => p.name)).toEqual(['Meat Pie'])

    const tags = (await request(httpServer).get('/ops/v1/catalog/products/tags?currency=INR').set('Authorization', `Bearer ${opsToken}`).expect(200)).body as { tags: string[] }
    expect(tags.tags).toEqual(['grill', 'north-indian', 'veg'])

    const edited = (await request(httpServer).patch(`/ops/v1/catalog/products/${paneer.id}`).set('Authorization', `Bearer ${opsToken}`).send({ suggestedPriceMinor: 25900, tags: ['veg'] }).expect(200)).body as { product: Product }
    expect(edited.product.suggestedPriceMinor).toBe(25900)
    expect(edited.product.tags).toEqual(['veg'])

    await request(httpServer).post('/ops/v1/catalog/products').set('Authorization', `Bearer ${opsToken}`).send({ ...PANEER, currency: 'USD' }).expect(400)
    await request(httpServer).delete(`/ops/v1/catalog/products/${paneer.id}?reason=Discontinued`).set('Authorization', `Bearer ${opsToken}`).expect(204)
    const deleted = await prisma.controlPlaneAuditEvent.findFirst({ where: { action: 'catalog.product.deleted' }, orderBy: { occurredAt: 'desc' } })
    expect(deleted?.reason).toBe('Paneer Tikka: Discontinued')
    await request(httpServer).delete(`/ops/v1/catalog/products/${paneer.id}`).set('Authorization', `Bearer ${opsToken}`).expect(404)
    await request(httpServer).get('/ops/v1/catalog/products').expect(401)
  })

  it('an owner only sees products in their currency and imports copies into their own menu', async () => {
    const paneer = await createProduct(PANEER)
    const chicken = await createProduct(CHICKEN)
    const pie = await createProduct(PIE)
    const india = await createOwner(prisma, 'IN')
    const australia = await createOwner(prisma, 'AU')

    const seen = (await request(httpServer).get('/admin/v1/menu/directory').set('Authorization', `Bearer ${india.token}`).expect(200)).body as { products: Product[] }
    expect(seen.products.map((p) => p.name).sort()).toEqual(['Butter Chicken', 'Paneer Tikka'])
    const tags = (await request(httpServer).get('/admin/v1/menu/directory/tags').set('Authorization', `Bearer ${india.token}`).expect(200)).body as { tags: string[] }
    expect(tags.tags).not.toContain('bakery')
    const byTag = (await request(httpServer).get('/admin/v1/menu/directory?tag=veg').set('Authorization', `Bearer ${india.token}`).expect(200)).body as { products: Product[] }
    expect(byTag.products.map((p) => p.name)).toEqual(['Paneer Tikka'])

    // A product from the other market is refused, and nothing is written.
    await request(httpServer).post('/admin/v1/menu/directory/import').set('Authorization', `Bearer ${india.token}`).send({ productIds: [paneer.id, pie.id] }).expect(400)
    expect(await prisma.menuItem.count({ where: { tenantId: india.tenantId } })).toBe(0)
    await request(httpServer).post('/admin/v1/menu/directory/import').set('Authorization', `Bearer ${india.token}`).send({ productIds: [] }).expect(400)

    const imported = (await request(httpServer).post('/admin/v1/menu/directory/import').set('Authorization', `Bearer ${india.token}`).send({ productIds: [paneer.id, chicken.id] }).expect(201)).body as ImportBody
    expect(imported.categories.map((c) => c.name).sort()).toEqual(['Mains', 'Starters'])
    expect(imported.items).toHaveLength(2)
    const importedPaneer = imported.items.find((i) => i.name === 'Paneer Tikka')
    expect(importedPaneer?.price).toMatchObject({ priceMinor: 24900, currency: 'INR' })

    const rows = await prisma.menuItem.findMany({ where: { tenantId: india.tenantId }, include: { prices: true } })
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.name === 'Paneer Tikka')?.vegMarker).toBe('veg')
    expect(await prisma.menuItem.count({ where: { tenantId: australia.tenantId } })).toBe(0)

    // The same product twice collides with the menu's name-per-category rule;
    // a new product in an existing category reuses that category. Editing the
    // copy never reaches the directory.
    await request(httpServer).post('/admin/v1/menu/directory/import').set('Authorization', `Bearer ${india.token}`).send({ productIds: [chicken.id] }).expect(409)
    const dal = await createProduct({ ...CHICKEN, name: 'Dal Makhani', shortName: 'Dal', vegMarker: 'veg' })
    const again = (await request(httpServer).post('/admin/v1/menu/directory/import').set('Authorization', `Bearer ${india.token}`).send({ productIds: [dal.id] }).expect(201)).body as ImportBody
    expect(again.categories).toEqual([])
    expect(again.items[0]?.categoryId).toBe(imported.items.find((i) => i.name === 'Butter Chicken')?.categoryId)
    await request(httpServer).patch(`/admin/v1/menu/items/${importedPaneer?.id}`).set('Authorization', `Bearer ${india.token}`).send({ name: 'Paneer Tikka (house)' }).expect(200)
    const directory = await prisma.catalogProduct.findUniqueOrThrow({ where: { id: paneer.id } })
    expect(directory.name).toBe('Paneer Tikka')

    const audit = await prisma.auditEvent.findFirst({ where: { tenantId: india.tenantId, action: 'menu.imported' } })
    expect(audit?.reason).toContain('product directory')
  })
})
