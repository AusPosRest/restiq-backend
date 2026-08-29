// CAP-4 success criteria, end to end:
//  - editing a price creates a new version, never mutates the old one (AD-11)
//  - a future-scheduled price never affects the current-price read until its
//    effective_at passes
//  - the 86 toggle is reflected immediately, in the same request
//  - a modifier group with min > max is rejected structurally
//  - allergen tags can be attached to / detached from an item
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'

interface VariantBody {
  id: string
  name: string
  sortOrder: number
}
interface ModifierBody {
  id: string
  name: string
  priceMinor: number
}
interface ModifierGroupBody {
  id: string
  name: string
  minSelections: number
  maxSelections: number
  modifiers: ModifierBody[]
}
interface AllergenBody {
  id: string
  name: string
}
interface ItemBody {
  id: string
  categoryId: string
  name: string
  shortName: string
  photoUrl: string | null
  nameHindi: string | null
  vegMarker: string | null
  available: boolean
  stationId: string | null
  variants: VariantBody[]
  modifierGroups: ModifierGroupBody[]
  allergens: AllergenBody[]
}
interface CategoryBody {
  id: string
  name: string
  sortOrder: number
  itemCount: number
}
interface ItemPriceBody {
  id: string
  itemId: string
  variantId: string | null
  channel: string | null
  outletId: string | null
  priceMinor: number
  currency: string
  effectiveAt: string
  createdAt: string
}
interface CurrentPriceBody {
  itemId: string
  variantId: string | null
  channel: string
  outletId: string | null
  priceMinor: number
  currency: string
  effectiveAt: string
}
interface ErrorBody {
  error: { code: string; message: string }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  // shifts/cash_movements (pos/CAP-10) restrict-delete tenants/outlets/staff;
  // wiped first for the same reason invoice/subscription is below.
  await prisma.cashMovement.deleteMany()
  await prisma.shift.deleteMany()
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
  await prisma.ticketEvent.deleteMany()
  await prisma.ticket.deleteMany()
  await prisma.order.deleteMany()
  await prisma.clockEvent.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
  // qr-self-order/CAP-1 (guest realm, issue #68): Guest FKs to table_sessions
  // (RESTRICT), and table_sessions FKs to dining_tables/outlets - both wiped
  // before diningTable.deleteMany() below for the same reason.
  await prisma.guest.deleteMany()
  await prisma.tableSession.deleteMany()
  await prisma.diningTable.deleteMany()
  await prisma.floor.deleteMany()
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

async function createOwner(prisma: PrismaClient): Promise<{ tenantId: string; token: string }> {
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
      country: 'IN',
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  const token = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@spiceroute.example' })
  return { tenantId, token }
}

async function createOutlet(prisma: PrismaClient, tenantId: string): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

describe('/admin/v1/menu (e2e)', () => {
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

  function authed(req: request.Test, token: string): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  async function createCategory(token: string, name = 'Mains'): Promise<CategoryBody> {
    const res = await authed(request(httpServer).post('/admin/v1/menu/categories'), token).send({ name })
    return res.body as CategoryBody
  }

  async function createItem(token: string, categoryId: string, overrides?: Record<string, unknown>): Promise<ItemBody> {
    const res = await authed(request(httpServer).post('/admin/v1/menu/items'), token).send({
      categoryId,
      name: 'Butter Chicken',
      shortName: 'Btr Chkn',
      ...overrides,
    })
    return res.body as ItemBody
  }

  describe('categories', () => {
    it('creates a category as a routine edit - no audit row written', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const res = await authed(request(httpServer).post('/admin/v1/menu/categories'), token).send({ name: 'Starters' })
      expect(res.status).toBe(201)
      const body = res.body as CategoryBody
      expect(body.name).toBe('Starters')
      expect(body.itemCount).toBe(0)
      expect(await prisma.auditEvent.count({ where: { tenantId } })).toBe(0)
    })

    it('lists categories with item counts, ordered by sortOrder', async () => {
      const { token } = await createOwner(prisma)
      const mains = await createCategory(token, 'Mains')
      await createCategory(token, 'Starters')
      await createItem(token, mains.id)

      const res = await authed(request(httpServer).get('/admin/v1/menu/categories'), token)
      expect(res.status).toBe(200)
      const body = res.body as CategoryBody[]
      expect(body).toHaveLength(2)
      expect(body.find((c) => c.id === mains.id)?.itemCount).toBe(1)
    })

    it('updates a category name', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const res = await authed(request(httpServer).patch(`/admin/v1/menu/categories/${category.id}`), token).send({ name: 'Chef Specials' })
      expect(res.status).toBe(200)
      expect((res.body as CategoryBody).name).toBe('Chef Specials')
    })

    it('rejects deleting a category that still has items (409)', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      await createItem(token, category.id)
      const res = await authed(request(httpServer).delete(`/admin/v1/menu/categories/${category.id}`), token)
      expect(res.status).toBe(409)
    })

    it('deletes an empty category', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const res = await authed(request(httpServer).delete(`/admin/v1/menu/categories/${category.id}`), token)
      expect(res.status).toBe(204)
    })

    it('never leaks a category across tenants', async () => {
      const owner1 = await createOwner(prisma)
      const owner2 = await createOwner(prisma)
      const category = await createCategory(owner1.token)
      const res = await authed(request(httpServer).patch(`/admin/v1/menu/categories/${category.id}`), owner2.token).send({ name: 'Stolen' })
      expect(res.status).toBe(404)
    })

    it('requires an admin session', async () => {
      const res = await request(httpServer).get('/admin/v1/menu/categories')
      expect(res.status).toBe(401)
    })
  })

  describe('items', () => {
    it('creates an item with a variant, a modifier group, and an allergen tag in one call', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const groupRes = await authed(request(httpServer).post('/admin/v1/menu/modifier-groups'), token).send({
        name: 'Spice Level',
        minSelections: 1,
        maxSelections: 1,
        modifiers: [{ name: 'Mild' }, { name: 'Hot', priceMinor: 0 }],
      })
      const allergenRes = await authed(request(httpServer).post('/admin/v1/menu/allergens'), token).send({ name: 'Dairy' })

      const res = await createItem(token, category.id, {
        variants: [{ name: 'Half' }, { name: 'Full' }],
        modifierGroupIds: [(groupRes.body as ModifierGroupBody).id],
        allergenIds: [(allergenRes.body as AllergenBody).id],
      })

      expect(res.variants).toHaveLength(2)
      expect(res.modifierGroups).toHaveLength(1)
      expect(res.modifierGroups[0]?.name).toBe('Spice Level')
      expect(res.allergens).toHaveLength(1)
      expect(res.allergens[0]?.name).toBe('Dairy')
    })

    it('gets an item by id with full nested detail', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const created = await createItem(token, category.id)
      const res = await authed(request(httpServer).get(`/admin/v1/menu/items/${created.id}`), token)
      expect(res.status).toBe(200)
      expect((res.body as ItemBody).name).toBe('Butter Chicken')
    })

    it('lists items filtered by category', async () => {
      const { token } = await createOwner(prisma)
      const mains = await createCategory(token, 'Mains')
      const starters = await createCategory(token, 'Starters')
      await createItem(token, mains.id, { name: 'Butter Chicken' })
      await createItem(token, starters.id, { name: 'Garden Salad' })

      const res = await authed(request(httpServer).get(`/admin/v1/menu/items?categoryId=${mains.id}`), token)
      const body = res.body as ItemBody[]
      expect(body).toHaveLength(1)
      expect(body[0]?.name).toBe('Butter Chicken')
    })

    it('never leaks an item across tenants', async () => {
      const owner1 = await createOwner(prisma)
      const owner2 = await createOwner(prisma)
      const category = await createCategory(owner1.token)
      const item = await createItem(owner1.token, category.id)
      const res = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}`), owner2.token)
      expect(res.status).toBe(404)
    })

    it('creates an item with photoUrl, nameHindi, and vegMarker, and reads them back', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)

      const created = await createItem(token, category.id, {
        photoUrl: 'https://cdn.example.com/photos/butter-chicken.jpg',
        nameHindi: 'बटर चिकन',
        vegMarker: 'non_veg',
      })

      expect(created.photoUrl).toBe('https://cdn.example.com/photos/butter-chicken.jpg')
      expect(created.nameHindi).toBe('बटर चिकन')
      expect(created.vegMarker).toBe('non_veg')

      const res = await authed(request(httpServer).get(`/admin/v1/menu/items/${created.id}`), token)
      expect(res.status).toBe(200)
      const fetched = res.body as ItemBody
      expect(fetched.photoUrl).toBe('https://cdn.example.com/photos/butter-chicken.jpg')
      expect(fetched.nameHindi).toBe('बटर चिकन')
      expect(fetched.vegMarker).toBe('non_veg')
    })

    it('updates photoUrl, nameHindi, and vegMarker via PATCH', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const created = await createItem(token, category.id)
      expect(created.photoUrl).toBeNull()
      expect(created.nameHindi).toBeNull()
      expect(created.vegMarker).toBeNull()

      const updated = await authed(request(httpServer).patch(`/admin/v1/menu/items/${created.id}`), token).send({
        photoUrl: 'https://cdn.example.com/photos/paneer.jpg',
        nameHindi: 'पनीर बटर मसाला',
        vegMarker: 'veg',
      })
      expect(updated.status).toBe(200)
      const body = updated.body as ItemBody
      expect(body.photoUrl).toBe('https://cdn.example.com/photos/paneer.jpg')
      expect(body.nameHindi).toBe('पनीर बटर मसाला')
      expect(body.vegMarker).toBe('veg')

      const fetched = await authed(request(httpServer).get(`/admin/v1/menu/items/${created.id}`), token)
      expect((fetched.body as ItemBody).vegMarker).toBe('veg')
    })

    it('rejects an invalid vegMarker on create', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const res = await authed(request(httpServer).post('/admin/v1/menu/items'), token).send({
        categoryId: category.id,
        name: 'Dal',
        shortName: 'Dal',
        vegMarker: 'vegan_friendly',
      })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('validation_failed')
    })

    describe('allergen tags CRUD on an item', () => {
      it('attaches and then removes allergen tags via PUT (replace-set)', async () => {
        const { token } = await createOwner(prisma)
        const category = await createCategory(token)
        const item = await createItem(token, category.id)
        const nuts = await authed(request(httpServer).post('/admin/v1/menu/allergens'), token).send({ name: 'Nuts' })
        const gluten = await authed(request(httpServer).post('/admin/v1/menu/allergens'), token).send({ name: 'Gluten' })

        const attach = await authed(request(httpServer).put(`/admin/v1/menu/items/${item.id}/allergens`), token).send({
          allergenIds: [(nuts.body as AllergenBody).id, (gluten.body as AllergenBody).id],
        })
        expect(attach.status).toBe(200)
        expect((attach.body as ItemBody).allergens.map((a) => a.name).sort()).toEqual(['Gluten', 'Nuts'])

        const detach = await authed(request(httpServer).put(`/admin/v1/menu/items/${item.id}/allergens`), token).send({ allergenIds: [] })
        expect(detach.status).toBe(200)
        expect((detach.body as ItemBody).allergens).toHaveLength(0)

        const fetched = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}`), token)
        expect((fetched.body as ItemBody).allergens).toHaveLength(0)
      })

      it('rejects an allergen id that belongs to another tenant', async () => {
        const owner1 = await createOwner(prisma)
        const owner2 = await createOwner(prisma)
        const category = await createCategory(owner1.token)
        const item = await createItem(owner1.token, category.id)
        const foreignAllergen = await authed(request(httpServer).post('/admin/v1/menu/allergens'), owner2.token).send({ name: 'Soy' })

        const res = await authed(request(httpServer).put(`/admin/v1/menu/items/${item.id}/allergens`), owner1.token).send({
          allergenIds: [(foreignAllergen.body as AllergenBody).id],
        })
        expect(res.status).toBe(400)
      })
    })

    describe('86 toggle (availability)', () => {
      it('is reflected immediately, in the same response, and on a subsequent read', async () => {
        const { token } = await createOwner(prisma)
        const category = await createCategory(token)
        const item = await createItem(token, category.id)
        expect(item.available).toBe(true)

        const toggled = await authed(request(httpServer).patch(`/admin/v1/menu/items/${item.id}/availability`), token).send({ available: false })
        expect(toggled.status).toBe(200)
        expect((toggled.body as ItemBody).available).toBe(false)

        const fetched = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}`), token)
        expect((fetched.body as ItemBody).available).toBe(false)
      })

      it('is not audited (routine, not security-relevant)', async () => {
        const { tenantId, token } = await createOwner(prisma)
        const category = await createCategory(token)
        const item = await createItem(token, category.id)
        await authed(request(httpServer).patch(`/admin/v1/menu/items/${item.id}/availability`), token).send({ available: false })
        expect(await prisma.auditEvent.count({ where: { tenantId, action: 'menu.item.price_changed' } })).toBe(0)
      })
    })

    describe('per-outlet availability override', () => {
      it('sets and clears an override without touching the tenant-wide flag', async () => {
        const { token, tenantId } = await createOwner(prisma)
        const outletId = await createOutlet(prisma, tenantId)
        const category = await createCategory(token)
        const item = await createItem(token, category.id)

        const set = await authed(request(httpServer).put(`/admin/v1/menu/items/${item.id}/outlets/${outletId}/availability`), token).send({ available: false })
        expect(set.status).toBe(200)
        expect(await prisma.itemOutletOverride.count({ where: { itemId: item.id, outletId } })).toBe(1)

        const stillTenantWide = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}`), token)
        expect((stillTenantWide.body as ItemBody).available).toBe(true)

        const cleared = await authed(request(httpServer).delete(`/admin/v1/menu/items/${item.id}/outlets/${outletId}/availability`), token)
        expect(cleared.status).toBe(204)
        expect(await prisma.itemOutletOverride.count({ where: { itemId: item.id, outletId } })).toBe(0)
      })
    })
  })

  describe('modifier groups', () => {
    it('creates a group with valid selection bounds', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).post('/admin/v1/menu/modifier-groups'), token).send({ name: 'Add-ons', minSelections: 0, maxSelections: 3 })
      expect(res.status).toBe(201)
      expect((res.body as ModifierGroupBody).maxSelections).toBe(3)
    })

    it('rejects min > max on create (structural validation)', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).post('/admin/v1/menu/modifier-groups'), token).send({ name: 'Bad Group', minSelections: 3, maxSelections: 1 })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('validation_failed')
      expect(await prisma.modifierGroup.count()).toBe(0)
    })

    it('rejects min > max on update, even when only one bound is patched', async () => {
      const { token } = await createOwner(prisma)
      const created = await authed(request(httpServer).post('/admin/v1/menu/modifier-groups'), token).send({ name: 'Spice Level', minSelections: 0, maxSelections: 1 })
      const res = await authed(request(httpServer).patch(`/admin/v1/menu/modifier-groups/${(created.body as ModifierGroupBody).id}`), token).send({ minSelections: 2 })
      expect(res.status).toBe(400)
    })

    it('rejects a negative selection bound', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).post('/admin/v1/menu/modifier-groups'), token).send({ name: 'Negative', minSelections: -1, maxSelections: 1 })
      expect(res.status).toBe(400)
    })

    it('adds a modifier to an existing group', async () => {
      const { token } = await createOwner(prisma)
      const created = await authed(request(httpServer).post('/admin/v1/menu/modifier-groups'), token).send({ name: 'Spice Level', minSelections: 1, maxSelections: 1 })
      const res = await authed(request(httpServer).post(`/admin/v1/menu/modifier-groups/${(created.body as ModifierGroupBody).id}/modifiers`), token).send({
        name: 'Extra Hot',
        priceMinor: 2000,
      })
      expect(res.status).toBe(201)
      expect((res.body as ModifierGroupBody).modifiers.some((m) => m.name === 'Extra Hot')).toBe(true)
    })
  })

  describe('pricing (AD-11)', () => {
    async function itemWithVariant(token: string): Promise<{ item: ItemBody; variantId: string }> {
      const category = await createCategory(token)
      const item = await createItem(token, category.id, { variants: [{ name: 'Full' }] })
      const variantId = item.variants[0]?.id
      if (!variantId) throw new Error('expected item to have a variant')
      return { item, variantId }
    }

    it('creates a NEW row on a price edit - the old row is never mutated (INSERT, not UPDATE)', async () => {
      const { token } = await createOwner(prisma)
      const { item, variantId } = await itemWithVariant(token)

      const first = await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        channel: 'dine_in',
        priceMinor: 19000,
        currency: 'INR',
        reason: 'Initial price',
      })
      expect(first.status).toBe(201)
      const firstBody = first.body as ItemPriceBody

      const second = await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        channel: 'dine_in',
        priceMinor: 21000,
        currency: 'INR',
        reason: 'Cost increase',
      })
      expect(second.status).toBe(201)
      const secondBody = second.body as ItemPriceBody
      expect(secondBody.id).not.toBe(firstBody.id)

      const rows = await prisma.itemPrice.findMany({ where: { itemId: item.id }, orderBy: { createdAt: 'asc' } })
      expect(rows).toHaveLength(2)
      // The old row exists, unchanged, at its original price.
      expect(rows[0]?.id).toBe(firstBody.id)
      expect(rows[0]?.priceMinor).toBe(19000n)
      expect(rows[1]?.id).toBe(secondBody.id)
      expect(rows[1]?.priceMinor).toBe(21000n)
    })

    it('requires a reason (price change is security-relevant) and audits it', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const { item, variantId } = await itemWithVariant(token)

      const missingReason = await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        channel: 'dine_in',
        priceMinor: 19000,
        currency: 'INR',
      })
      expect(missingReason.status).toBe(400)

      const ok = await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        channel: 'dine_in',
        priceMinor: 19000,
        currency: 'INR',
        reason: 'Initial price',
      })
      expect(ok.status).toBe(201)
      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'menu.item.price_changed' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.reason).toBe('Initial price')
    })

    it('current-price read resolves the immediate price and ignores a future-scheduled one', async () => {
      const { token } = await createOwner(prisma)
      const { item, variantId } = await itemWithVariant(token)

      await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        channel: 'dine_in',
        priceMinor: 19000,
        currency: 'INR',
        reason: 'Initial price',
      })

      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      const scheduled = await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        channel: 'dine_in',
        priceMinor: 25000,
        currency: 'INR',
        effectiveAt: future,
        reason: 'Scheduled increase',
      })
      expect(scheduled.status).toBe(201)

      const current = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}/price?channel=dine_in&variantId=${variantId}`), token)
      expect(current.status).toBe(200)
      // Still the immediate price - the future row must never win.
      expect((current.body as CurrentPriceBody).priceMinor).toBe(19000)

      // Simulate time passing: the scheduled row's effective_at moves to
      // "now" (set directly, as the future write already happened - this is
      // the read path under test, not a second write). "Now" is guaranteed
      // later than the first row's effectiveAt, which was stamped when it
      // was created a moment earlier - no shared timestamp to tie-break on.
      await prisma.itemPrice.updateMany({ where: { id: (scheduled.body as ItemPriceBody).id }, data: { effectiveAt: new Date() } })

      const afterTimePasses = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}/price?channel=dine_in&variantId=${variantId}`), token)
      expect((afterTimePasses.body as CurrentPriceBody).priceMinor).toBe(25000)
    })

    it('404s when no price exists for the given channel', async () => {
      const { token } = await createOwner(prisma)
      const { item, variantId } = await itemWithVariant(token)
      const res = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}/price?channel=delivery&variantId=${variantId}`), token)
      expect(res.status).toBe(404)
    })

    it('an outlet-specific price overrides the tenant-wide price for that outlet only', async () => {
      const { token, tenantId } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const { item, variantId } = await itemWithVariant(token)

      await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        channel: 'dine_in',
        priceMinor: 19000,
        currency: 'INR',
        reason: 'Tenant-wide price',
      })
      await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId,
        outletId,
        channel: 'dine_in',
        priceMinor: 17500,
        currency: 'INR',
        reason: 'Outlet promo price',
      })

      const atOutlet = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}/price?channel=dine_in&variantId=${variantId}&outletId=${outletId}`), token)
      expect((atOutlet.body as CurrentPriceBody).priceMinor).toBe(17500)

      const elsewhere = await authed(request(httpServer).get(`/admin/v1/menu/items/${item.id}/price?channel=dine_in&variantId=${variantId}`), token)
      expect((elsewhere.body as CurrentPriceBody).priceMinor).toBe(19000)
    })

    it('rejects a variant that does not belong to the item', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const item = await createItem(token, category.id)
      const res = await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), token).send({
        variantId: uuidv7(),
        channel: 'dine_in',
        priceMinor: 19000,
        currency: 'INR',
        reason: 'Bad variant',
      })
      expect(res.status).toBe(400)
    })

    it('never leaks a price write across tenants', async () => {
      const owner1 = await createOwner(prisma)
      const owner2 = await createOwner(prisma)
      const category = await createCategory(owner1.token)
      const item = await createItem(owner1.token, category.id)
      const res = await authed(request(httpServer).post(`/admin/v1/menu/items/${item.id}/prices`), owner2.token).send({
        channel: 'dine_in',
        priceMinor: 19000,
        currency: 'INR',
        reason: 'Attempted cross-tenant write',
      })
      expect(res.status).toBe(404)
    })
  })

  describe('combos', () => {
    it('creates a combo bundling existing items at a flat price', async () => {
      const { token } = await createOwner(prisma)
      const category = await createCategory(token)
      const item1 = await createItem(token, category.id, { name: 'Butter Chicken' })
      const item2 = await createItem(token, category.id, { name: 'Garlic Naan' })

      const res = await authed(request(httpServer).post('/admin/v1/menu/combos'), token).send({
        name: 'Combo A',
        priceMinor: 35000,
        currency: 'INR',
        components: [
          { itemId: item1.id, quantity: 1 },
          { itemId: item2.id, quantity: 2 },
        ],
      })
      expect(res.status).toBe(201)
      const list = await authed(request(httpServer).get('/admin/v1/menu/combos'), token)
      expect(list.body).toHaveLength(1)
    })
  })
})
