// pos/CAP-3's menu read (restiq-web#66/restiq-backend#66): `GET /pos/v1/menu`
// - the read restiq-web's order-taking screen (order-taking-state.ts's
// PosMenuView) has depended on since it was built, never actually backed by
// a real endpoint until now. Mirrors pos-order-lines.e2e-spec.ts's
// wipe()/createTenant()/createOutlet()/createStaff()/createItemWithPrice()
// helpers verbatim (same fixture shapes, same db) rather than reinventing
// them.
//
// Success criteria this file proves:
//  - categories/items/modifier groups render with a single dine-in price
//    already resolved server-side (menu.service.ts reuses
//    admin/menu/pricing.ts's resolveCurrentPrice, same function
//    order-lines.service.ts snapshots a line's price from - no second
//    price-picking implementation to verify separately).
//  - a variant-priced item carries its price per-variant (priceMinor: null
//    on the item itself), an unvaried item carries it directly on the item.
//  - a variant/item with no resolvable current price is dropped, never shown
//    with a fabricated ₹0 (menu.service.ts's own documented posture).
//  - a per-outlet availability override (ItemOutletOverride) wins over the
//    item's own `available` flag.
//  - scoped to the calling staff's own outlet (PosPrincipal.outletId) and
//    tenant - no outlet param on the route, no cross-tenant leakage.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface MenuVariantBody {
  id: string
  name: string
  priceMinor: number
}
interface MenuItemBody {
  id: string
  categoryId: string
  name: string
  shortName: string
  available: boolean
  priceMinor: number | null
  variants: MenuVariantBody[]
  modifierGroups: { id: string; name: string; minSelections: number; maxSelections: number; modifiers: { id: string; name: string; priceMinor: number }[] }[]
}
interface MenuCategoryBody {
  id: string
  name: string
  sortOrder: number
}
interface MenuBody {
  categories: MenuCategoryBody[]
  items: MenuItemBody[]
  currency: string
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // Same order as pos-order-lines.e2e-spec.ts's wipe() - kept identical so
  // this file behaves the same way regardless of which spec runs last.
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

async function createTenant(prisma: PrismaClient, name = 'Spice Route Hospitality'): Promise<string> {
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

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const token = signPosToken({ id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function createItemWithPrice(
  prisma: PrismaClient,
  tenantId: string,
  priceMinor: number,
  opts?: { withVariant?: boolean; modifierGroup?: { minSelections: number; maxSelections: number; modifiers: number[] }; categoryId?: string; available?: boolean },
): Promise<{ itemId: string; categoryId: string; variantId: string | null; modifierGroupId: string | null; modifierIds: string[] }> {
  const categoryId = opts?.categoryId ?? (await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })).id
  const item = await prisma.menuItem.create({
    data: { tenantId, categoryId, name: `Item-${uuidv7()}`, shortName: 'Itm', available: opts?.available ?? true },
  })

  let variantId: string | null = null
  if (opts?.withVariant) {
    const variant = await prisma.itemVariant.create({ data: { tenantId, itemId: item.id, name: 'Full', sortOrder: 0 } })
    variantId = variant.id
  }

  await prisma.itemPrice.create({
    data: { tenantId, itemId: item.id, variantId, priceMinor: BigInt(priceMinor), currency: 'INR', channel: 'dine_in' },
  })

  let modifierGroupId: string | null = null
  const modifierIds: string[] = []
  if (opts?.modifierGroup) {
    const group = await prisma.modifierGroup.create({
      data: { tenantId, name: `Group-${uuidv7()}`, minSelections: opts.modifierGroup.minSelections, maxSelections: opts.modifierGroup.maxSelections },
    })
    modifierGroupId = group.id
    await prisma.itemModifierGroup.create({ data: { tenantId, itemId: item.id, groupId: group.id, sortOrder: 0 } })
    for (const [i, priceForModifier] of opts.modifierGroup.modifiers.entries()) {
      const modifier = await prisma.modifier.create({ data: { tenantId, groupId: group.id, name: `Mod-${i}`, priceMinor: BigInt(priceForModifier), sortOrder: i } })
      modifierIds.push(modifier.id)
    }
  }

  return { itemId: item.id, categoryId, variantId, modifierGroupId, modifierIds }
}

describe('/pos/v1/menu (e2e)', () => {
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
    // Same why-clean-up-on-the-way-out discipline as pos-order-lines.e2e-spec.ts's
    // afterAll - never leave rows another spec file's own wipe() doesn't expect.
    await wipe(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
  })

  function authed(req: request.Test, token: string): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  it('returns categories and an unvaried item with its resolved dine-in price', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const { itemId, categoryId } = await createItemWithPrice(prisma, tenantId, 19000)

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    expect(res.status).toBe(200)
    const body = res.body as MenuBody
    expect(body.currency).toBe('INR')
    expect(body.categories).toEqual([expect.objectContaining({ id: categoryId })])
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ id: itemId, categoryId, priceMinor: 19000, variants: [], available: true })
  })

  it('prices a varianted item per-variant, with a null base price', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const { itemId, variantId } = await createItemWithPrice(prisma, tenantId, 25000, { withVariant: true })

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    const item = (res.body as MenuBody).items.find((i) => i.id === itemId)
    expect(item?.priceMinor).toBeNull()
    expect(item?.variants).toEqual([expect.objectContaining({ id: variantId, priceMinor: 25000 })])
  })

  it('carries modifier groups and their modifiers with resolved prices', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const { itemId, modifierGroupId, modifierIds } = await createItemWithPrice(prisma, tenantId, 19000, {
      modifierGroup: { minSelections: 1, maxSelections: 1, modifiers: [0, 5000] },
    })

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    const item = (res.body as MenuBody).items.find((i) => i.id === itemId)
    expect(item?.modifierGroups).toEqual([
      expect.objectContaining({
        id: modifierGroupId,
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          expect.objectContaining({ id: modifierIds[0], priceMinor: 0 }),
          expect.objectContaining({ id: modifierIds[1], priceMinor: 5000 }),
        ],
      }),
    ])
  })

  it('drops an item with no resolvable current price, rather than showing a fabricated ₹0', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const noPriceItem = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'No Price Item', shortName: 'NPI' } })
    const { itemId: pricedItemId } = await createItemWithPrice(prisma, tenantId, 19000, { categoryId: category.id })

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    const body = res.body as MenuBody
    expect(body.items.map((i) => i.id)).toEqual([pricedItemId])
    expect(body.items.find((i) => i.id === noPriceItem.id)).toBeUndefined()
  })

  it("drops a variant with no resolvable current price, keeping the item's other priced variants", async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'Paneer Tikka', shortName: 'Paneer' } })
    const pricedVariant = await prisma.itemVariant.create({ data: { tenantId, itemId: item.id, name: 'Half', sortOrder: 0 } })
    const unpricedVariant = await prisma.itemVariant.create({ data: { tenantId, itemId: item.id, name: 'Full', sortOrder: 1 } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, variantId: pricedVariant.id, priceMinor: 34000n, currency: 'INR', channel: 'dine_in' } })

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    const menuItem = (res.body as MenuBody).items.find((i) => i.id === item.id)
    expect(menuItem?.variants.map((v) => v.id)).toEqual([pricedVariant.id])
    expect(menuItem?.variants.map((v) => v.id)).not.toContain(unpricedVariant.id)
  })

  it("a per-outlet availability override wins over the item's own available flag", async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const { itemId } = await createItemWithPrice(prisma, tenantId, 19000, { available: true })
    await prisma.itemOutletOverride.create({ data: { tenantId, itemId, outletId, available: false } })

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    const item = (res.body as MenuBody).items.find((i) => i.id === itemId)
    expect(item?.available).toBe(false)
  })

  it("does not apply another outlet's ItemOutletOverride - only the calling staff's own outlet's override applies", async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const otherOutletId = await createOutlet(prisma, tenantId, 'Koramangala')
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const { itemId } = await createItemWithPrice(prisma, tenantId, 19000, { available: true })
    await prisma.itemOutletOverride.create({ data: { tenantId, itemId, outletId: otherOutletId, available: false } })

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    const item = (res.body as MenuBody).items.find((i) => i.id === itemId)
    expect(item?.available).toBe(true)
  })

  it("is scoped to the calling staff's own tenant - no cross-tenant items leak in", async () => {
    const tenantId = await createTenant(prisma)
    const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
    const outletId = await createOutlet(prisma, tenantId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const { itemId: ownItemId } = await createItemWithPrice(prisma, tenantId, 19000)
    await createItemWithPrice(prisma, otherTenantId, 19000)

    const res = await authed(request(httpServer).get('/pos/v1/menu'), waiter.token)
    const body = res.body as MenuBody
    expect(body.items.map((i) => i.id)).toEqual([ownItemId])
  })

  it('rejects an unauthenticated request', async () => {
    const res = await request(httpServer).get('/pos/v1/menu')
    expect(res.status).toBe(401)
  })
})
