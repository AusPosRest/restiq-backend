// qr-self-order/CAP-2 success criteria, end to end (SPEC-qr-self-order,
// stories.yaml story 2):
//  - the menu is scoped to the guest's own outlet (categories/items with
//    prices/variants/modifier groups/allergens from the real catalogue)
//  - an 86'd item (tenant-wide or per-outlet override) is included but
//    marked unavailable, never omitted
//  - prices match the real pricing resolver (admin/menu/pricing, reused
//    through the admin barrel) - not re-derived
//  - a guest token is required (401 without one); other realms' tokens are
//    rejected the same way guest-realm.e2e-spec.ts already proves generally
//  - cross-tenant isolation: a guest from tenant A never sees tenant B's menu
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { GuestPrincipal, signGuestToken, signPosToken, uuidv7 } from '../src/platform'

interface MenuItemBody {
  id: string
  categoryId: string
  name: string
  shortName: string
  available: boolean
  priceMinor: number | null
  currency: string | null
  variants: { id: string; name: string; sortOrder: number; priceMinor: number | null; currency: string | null }[]
  modifierGroups: { id: string; name: string; minSelections: number; maxSelections: number; modifiers: { id: string; name: string; priceMinor: number }[] }[]
  allergens: { id: string; name: string }[]
}
interface MenuCategoryBody {
  id: string
  name: string
  sortOrder: number
  items: MenuItemBody[]
}
interface GuestMenuBody {
  outletId: string
  categories: MenuCategoryBody[]
}
interface ErrorBody {
  error: { code: string; message: string }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.orderLine.deleteMany()
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
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
  await prisma.order.deleteMany()
  await prisma.clockEvent.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
  await prisma.guest.deleteMany()
  await prisma.tableSession.deleteMany()
  await prisma.diningTable.deleteMany()
  await prisma.floor.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

async function createTenant(prisma: PrismaClient, name = 'Menu Test Co'): Promise<string> {
  const tenantId = uuidv7()
  await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name,
      registeredAddress: '1 Test Street',
      contactName: 'Test Contact',
      contactEmail: 'contact@test.example',
      contactPhone: '+91 90000 00000',
      country: 'IN',
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  return tenantId
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Koramangala'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Menu Test Brand' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createTable(prisma: PrismaClient, tenantId: string, outletId: string, label = 'T1'): Promise<string> {
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
  const table = await prisma.diningTable.create({
    data: { tenantId, floorId: floor.id, label, x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 },
  })
  return table.id
}

function guestTokenFor(tenantId: string, outletId: string, tableId: string): { token: string; principal: GuestPrincipal } {
  const principal: GuestPrincipal = { id: uuidv7(), sessionId: uuidv7(), tenantId, outletId, tableId, name: 'Asha' }
  return { token: signGuestToken(principal), principal }
}

describe('/guest/v1/menu (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await wipe(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  it('rejects the menu without a guest token', async () => {
    const res = await request(httpServer).get('/guest/v1/menu')
    expect(res.status).toBe(401)
  })

  it('rejects a pos-realm token on the guest menu route', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const posToken = signPosToken({ id: uuidv7(), tenantId, outletId, name: 'Server' })
    const res = await request(httpServer).get('/guest/v1/menu').set('Authorization', `Bearer ${posToken}`)
    expect(res.status).toBe(401)
  })

  it('returns the real catalogue for the guest\'s outlet: categories, items, prices, variants, modifier groups, allergens', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)

    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Butter Chicken', shortName: 'BC' } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 42000n, currency: 'INR', channel: 'qr' } })

    const allergen = await prisma.allergen.create({ data: { tenantId, name: 'Dairy' } })
    await prisma.itemAllergen.create({ data: { tenantId, itemId: item.id, allergenId: allergen.id } })

    const group = await prisma.modifierGroup.create({ data: { tenantId, name: 'Spice Level', minSelections: 1, maxSelections: 1 } })
    const modifier = await prisma.modifier.create({ data: { tenantId, groupId: group.id, name: 'Extra Hot', priceMinor: 0n, sortOrder: 0 } })
    await prisma.itemModifierGroup.create({ data: { tenantId, itemId: item.id, groupId: group.id, sortOrder: 0 } })

    const itemWithVariant = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Naan', shortName: 'Naan' } })
    const variant = await prisma.itemVariant.create({ data: { tenantId, itemId: itemWithVariant.id, name: 'Full', sortOrder: 0 } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: itemWithVariant.id, variantId: variant.id, priceMinor: 6000n, currency: 'INR', channel: 'qr' } })

    const { token } = guestTokenFor(tenantId, outletId, tableId)
    const res = await request(httpServer).get('/guest/v1/menu').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)

    const body = res.body as GuestMenuBody
    expect(body.outletId).toBe(outletId)
    expect(body.categories).toHaveLength(1)
    const mains = body.categories[0]
    expect(mains.name).toBe('Mains')
    expect(mains.items).toHaveLength(2)

    const butterChicken = mains.items.find((i) => i.name === 'Butter Chicken')!
    expect(butterChicken.available).toBe(true)
    expect(butterChicken.priceMinor).toBe(42000)
    expect(butterChicken.currency).toBe('INR')
    expect(butterChicken.allergens).toEqual([{ id: allergen.id, name: 'Dairy' }])
    expect(butterChicken.modifierGroups).toEqual([
      { id: group.id, name: 'Spice Level', minSelections: 1, maxSelections: 1, modifiers: [{ id: modifier.id, name: 'Extra Hot', priceMinor: 0 }] },
    ])
    expect(butterChicken.variants).toEqual([])

    const naan = mains.items.find((i) => i.name === 'Naan')!
    expect(naan.priceMinor).toBeNull()
    expect(naan.variants).toEqual([{ id: variant.id, name: 'Full', sortOrder: 0, priceMinor: 6000, currency: 'INR' }])
  })

  it("matches admin/menu/pricing's own resolution: an outlet-specific qr price beats the unscoped one", async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)

    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Dal Makhani', shortName: 'Dal' } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 30000n, currency: 'INR', channel: 'qr' } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, outletId, priceMinor: 32000n, currency: 'INR', channel: 'qr' } })

    const { token } = guestTokenFor(tenantId, outletId, tableId)
    const res = await request(httpServer).get('/guest/v1/menu').set('Authorization', `Bearer ${token}`)
    const item0 = (res.body as GuestMenuBody).categories[0].items[0]
    expect(item0.priceMinor).toBe(32000)
  })

  it('includes a tenant-wide 86\'d item marked unavailable, never omitted', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)

    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Sold Out Curry', shortName: 'SOC', available: false } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 25000n, currency: 'INR', channel: 'qr' } })

    const { token } = guestTokenFor(tenantId, outletId, tableId)
    const res = await request(httpServer).get('/guest/v1/menu').set('Authorization', `Bearer ${token}`)
    const items = (res.body as GuestMenuBody).categories[0].items
    expect(items).toHaveLength(1)
    expect(items[0].available).toBe(false)
  })

  it('a per-outlet override marks an otherwise-available item unavailable at that outlet only', async () => {
    const tenantId = await createTenant(prisma)
    const outletA = await createOutlet(prisma, tenantId, 'Koramangala')
    const outletB = await createOutlet(prisma, tenantId, 'Indiranagar')
    const tableA = await createTable(prisma, tenantId, outletA, 'A1')
    const tableB = await createTable(prisma, tenantId, outletB, 'B1')

    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Fish Curry', shortName: 'FC' } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 35000n, currency: 'INR', channel: 'qr' } })
    await prisma.itemOutletOverride.create({ data: { tenantId, itemId: item.id, outletId: outletA, available: false } })

    const guestA = guestTokenFor(tenantId, outletA, tableA)
    const resA = await request(httpServer).get('/guest/v1/menu').set('Authorization', `Bearer ${guestA.token}`)
    expect((resA.body as GuestMenuBody).categories[0].items[0].available).toBe(false)

    const guestB = guestTokenFor(tenantId, outletB, tableB)
    const resB = await request(httpServer).get('/guest/v1/menu').set('Authorization', `Bearer ${guestB.token}`)
    expect((resB.body as GuestMenuBody).categories[0].items[0].available).toBe(true)
  })

  it('never leaks another tenant\'s menu to this guest (cross-tenant isolation)', async () => {
    const tenantA = await createTenant(prisma, 'Tenant A')
    const outletA = await createOutlet(prisma, tenantA)
    const tableA = await createTable(prisma, tenantA, outletA)
    const categoryA = await prisma.menuCategory.create({ data: { tenantId: tenantA, name: 'A Mains', sortOrder: 0 } })
    await prisma.menuItem.create({ data: { tenantId: tenantA, categoryId: categoryA.id, name: 'A Item', shortName: 'AI' } })

    const tenantB = await createTenant(prisma, 'Tenant B')
    await createOutlet(prisma, tenantB)
    const categoryB = await prisma.menuCategory.create({ data: { tenantId: tenantB, name: 'B Mains', sortOrder: 0 } })
    await prisma.menuItem.create({ data: { tenantId: tenantB, categoryId: categoryB.id, name: 'B Item', shortName: 'BI' } })

    const { token } = guestTokenFor(tenantA, outletA, tableA)
    const res = await request(httpServer).get('/guest/v1/menu').set('Authorization', `Bearer ${token}`)
    const body = res.body as GuestMenuBody
    expect(body.categories).toHaveLength(1)
    expect(body.categories[0].name).toBe('A Mains')
    expect(body.categories[0].items.map((i) => i.name)).toEqual(['A Item'])
  })

  it('GET /guest/v1/menu/items/:itemId returns one item detail, scoped the same way', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Paneer Tikka', shortName: 'PT' } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 28000n, currency: 'INR', channel: 'qr' } })

    const { token } = guestTokenFor(tenantId, outletId, tableId)
    const res = await request(httpServer).get(`/guest/v1/menu/items/${item.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const body = res.body as MenuItemBody
    expect(body.id).toBe(item.id)
    expect(body.priceMinor).toBe(28000)
  })

  it('404s for an item that belongs to a different tenant', async () => {
    const tenantA = await createTenant(prisma, 'Tenant A2')
    const outletA = await createOutlet(prisma, tenantA)
    const tableA = await createTable(prisma, tenantA, outletA)

    const tenantB = await createTenant(prisma, 'Tenant B2')
    const categoryB = await prisma.menuCategory.create({ data: { tenantId: tenantB, name: 'B Mains', sortOrder: 0 } })
    const itemB = await prisma.menuItem.create({ data: { tenantId: tenantB, categoryId: categoryB.id, name: 'B Item', shortName: 'BI' } })

    const { token } = guestTokenFor(tenantA, outletA, tableA)
    const res = await request(httpServer).get(`/guest/v1/menu/items/${itemB.id}`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect((res.body as ErrorBody).error.code).toBe('not_found')
  })
})
