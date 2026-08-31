// qr-self-order/CAP-3 success criteria, end to end (SPEC-qr-self-order,
// story 3):
//  - every guest in a session adds to one shared table cart, each line
//    attributed to the guest who added it - guest B sees guest A's lines
//    (with attribution) on its own GET, and vice versa
//  - only the guest who added a line may edit or remove it (403 otherwise);
//    any guest may view all lines
//  - a modifier selection violating a group's min/max is rejected 400
//    server-side, exactly the POS rule (pos/orders/order-lines.service.ts)
//  - an 86'd item (tenant-wide or this outlet's override) cannot be added
//  - the combined view groups by guest with correct per-guest subtotals and
//    a correct combined total
//  - a closed/settled session 410s every cart call
//  - cross-tenant/cross-realm isolation: RLS scoping and the guest-only
//    guard on /guest/* routes
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface CartLineModifierBody {
  id: string
  name: string
  priceMinor: number
}
interface CartLineBody {
  id: string
  guestId: string
  guestName: string
  itemId: string
  itemName: string
  variantId: string | null
  variantName: string | null
  quantity: number
  unitPriceMinor: number
  modifiers: CartLineModifierBody[]
  lineTotalMinor: number
  createdAt: string
}
interface GuestCartBody {
  guestId: string
  guestName: string
  lines: CartLineBody[]
  subtotalMinor: number
}
interface TableCartBody {
  sessionId: string
  guests: GuestCartBody[]
  totalMinor: number
  currency: string
}
interface StartResult {
  token: string
  pin: string
  session: { sessionId: string }
}
interface JoinResult {
  token: string
  session: { sessionId: string }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.creditNote.deleteMany()
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
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
  await prisma.billShare.deleteMany()
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

async function createTenant(prisma: PrismaClient, name = 'Guest Cart Test Co'): Promise<string> {
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
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Guest Cart Test Brand' } })
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

async function enableQrOrdering(prisma: PrismaClient, tenantId: string, outletId: string): Promise<void> {
  await prisma.outletCapability.upsert({
    where: { outletId_key: { outletId, key: 'qr_ordering' } },
    create: { tenantId, outletId, key: 'qr_ordering', enabled: true },
    update: { enabled: true },
  })
}

async function createItemWithPrice(
  prisma: PrismaClient,
  tenantId: string,
  priceMinor: number,
  opts?: { withVariant?: boolean; modifierGroup?: { minSelections: number; maxSelections: number; modifiers: number[] }; available?: boolean },
): Promise<{ itemId: string; variantId: string | null; modifierIds: string[] }> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({
    data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm', available: opts?.available ?? true },
  })

  let variantId: string | null = null
  if (opts?.withVariant) {
    const variant = await prisma.itemVariant.create({ data: { tenantId, itemId: item.id, name: 'Full', sortOrder: 0 } })
    variantId = variant.id
  }

  // Channel omitted (null = unscoped) so it applies to the guest cart's
  // 'qr' pricing channel the same as it would to any other.
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, variantId, priceMinor: BigInt(priceMinor), currency: 'INR' } })

  const modifierIds: string[] = []
  if (opts?.modifierGroup) {
    const group = await prisma.modifierGroup.create({
      data: { tenantId, name: `Group-${uuidv7()}`, minSelections: opts.modifierGroup.minSelections, maxSelections: opts.modifierGroup.maxSelections },
    })
    await prisma.itemModifierGroup.create({ data: { tenantId, itemId: item.id, groupId: group.id, sortOrder: 0 } })
    for (const [i, priceForModifier] of opts.modifierGroup.modifiers.entries()) {
      const modifier = await prisma.modifier.create({ data: { tenantId, groupId: group.id, name: `Mod-${i}`, priceMinor: BigInt(priceForModifier), sortOrder: i } })
      modifierIds.push(modifier.id)
    }
  }

  return { itemId: item.id, variantId, modifierIds }
}

describe('/guest/v1/cart shared group cart (e2e)', () => {
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

  async function startAndJoin(prisma_: PrismaClient, outletId: string, tableId: string): Promise<{ tokenA: string; tokenB: string; sessionId: string }> {
    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    const { token: tokenA, pin, session } = startRes.body as StartResult
    const joinRes = await request(httpServer).post('/guest/v1/sessions/join').send({ outletId, tableId, pin, name: 'Rohan' })
    const { token: tokenB } = joinRes.body as JoinResult
    void prisma_
    return { tokenA, tokenB, sessionId: session.sessionId }
  }

  describe('shared cart and attribution', () => {
    it('guest B sees guest A\'s items attributed, and vice versa', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA, tokenB } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)

      const addA = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 2 })
      expect(addA.status).toBe(201)

      const { itemId: itemId2 } = await createItemWithPrice(prisma, tenantId, 9000)
      const addB = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenB).send({ itemId: itemId2, quantity: 1 })
      expect(addB.status).toBe(201)

      const viewFromA = await authed(request(httpServer).get('/guest/v1/cart'), tokenA)
      const viewFromB = await authed(request(httpServer).get('/guest/v1/cart'), tokenB)
      expect(viewFromA.status).toBe(200)
      expect(viewFromB.status).toBe(200)

      for (const cart of [viewFromA.body as TableCartBody, viewFromB.body as TableCartBody]) {
        expect(cart.guests).toHaveLength(2)
        const ashaCart = cart.guests.find((g) => g.guestName === 'Asha')
        const rohanCart = cart.guests.find((g) => g.guestName === 'Rohan')
        expect(ashaCart?.lines).toEqual([expect.objectContaining({ itemId, quantity: 2, unitPriceMinor: 19000 })])
        expect(rohanCart?.lines).toEqual([expect.objectContaining({ itemId: itemId2, quantity: 1, unitPriceMinor: 9000 })])
      }
    })

    it('groups by guest with correct per-guest subtotals and a correct combined total', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA, tokenB } = await startAndJoin(prisma, outletId, tableId)
      const { itemId: itemA } = await createItemWithPrice(prisma, tenantId, 15000)
      const { itemId: itemB } = await createItemWithPrice(prisma, tenantId, 8000)

      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: itemA, quantity: 2 }) // 30000
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenB).send({ itemId: itemB, quantity: 3 }) // 24000

      const res = await authed(request(httpServer).get('/guest/v1/cart'), tokenA)
      const cart = res.body as TableCartBody
      const ashaCart = cart.guests.find((g) => g.guestName === 'Asha')
      const rohanCart = cart.guests.find((g) => g.guestName === 'Rohan')
      expect(ashaCart?.subtotalMinor).toBe(30000)
      expect(rohanCart?.subtotalMinor).toBe(24000)
      expect(cart.totalMinor).toBe(54000)
    })

    it('resolves modifier prices into the line total', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId, modifierIds } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 1, maxSelections: 1, modifiers: [0, 5000] },
      })

      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 2, modifierIds: [modifierIds[1]] })
      expect(res.status).toBe(201)
      const cart = res.body as TableCartBody
      const line = cart.guests[0]?.lines[0]
      expect(line?.modifiers).toEqual([expect.objectContaining({ priceMinor: 5000 })])
      // (19000 + 5000) * 2
      expect(line?.lineTotalMinor).toBe(48000)
    })
  })

  describe('ownership rules', () => {
    it('a guest cannot edit another guest\'s line (403)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA, tokenB } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)

      const added = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1 })
      const lineId = (added.body as TableCartBody).guests[0]?.lines[0]?.id

      const res = await authed(request(httpServer).patch(`/guest/v1/cart/lines/${lineId}`), tokenB).send({ quantity: 5 })
      expect(res.status).toBe(403)
      expect((res.body as ErrorBody).error.code).toBe('forbidden')
    })

    it('a guest cannot remove another guest\'s line (403)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA, tokenB } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)

      const added = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1 })
      const lineId = (added.body as TableCartBody).guests[0]?.lines[0]?.id

      const res = await authed(request(httpServer).delete(`/guest/v1/cart/lines/${lineId}`), tokenB)
      expect(res.status).toBe(403)
      expect(await prisma.cartLine.count({ where: { id: lineId } })).toBe(1)
    })

    it('the line\'s own guest can edit and remove it', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)

      const added = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1 })
      const lineId = (added.body as TableCartBody).guests[0]?.lines[0]?.id

      const updated = await authed(request(httpServer).patch(`/guest/v1/cart/lines/${lineId}`), tokenA).send({ quantity: 4 })
      expect(updated.status).toBe(200)
      expect((updated.body as TableCartBody).guests[0]?.lines[0]).toMatchObject({ quantity: 4 })

      const removed = await authed(request(httpServer).delete(`/guest/v1/cart/lines/${lineId}`), tokenA)
      expect(removed.status).toBe(200)
      expect((removed.body as TableCartBody).guests).toHaveLength(0)
      expect(await prisma.cartLine.count({ where: { id: lineId } })).toBe(0)
    })
  })

  describe('modifier min/max validation (same server-side rule as POS)', () => {
    it('rejects a line violating a modifier group\'s min/max, even with no selection at all', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 1, maxSelections: 1, modifiers: [0, 5000] },
      })

      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1, modifierIds: [] })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('modifier_selection_invalid')
      expect(await prisma.cartLine.count()).toBe(0)
    })

    it('rejects selecting more modifiers than a group\'s max allows', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId, modifierIds } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 0, maxSelections: 1, modifiers: [0, 5000] },
      })

      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1, modifierIds })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('modifier_selection_invalid')
    })

    it('re-validates min/max on PATCH re-selection', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId, modifierIds } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 1, maxSelections: 1, modifiers: [0, 5000] },
      })
      const added = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1, modifierIds: [modifierIds[0]] })
      const lineId = (added.body as TableCartBody).guests[0]?.lines[0]?.id

      const bad = await authed(request(httpServer).patch(`/guest/v1/cart/lines/${lineId}`), tokenA).send({ modifierIds: [] })
      expect(bad.status).toBe(400)

      const good = await authed(request(httpServer).patch(`/guest/v1/cart/lines/${lineId}`), tokenA).send({ modifierIds: [modifierIds[1]] })
      expect(good.status).toBe(200)
    })
  })

  describe('86\'d items', () => {
    it('rejects a tenant-wide 86\'d item', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000, { available: false })

      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1 })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('item_unavailable')
    })

    it('rejects an item 86\'d for this specific outlet via ItemOutletOverride', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      await prisma.itemOutletOverride.create({ data: { tenantId, itemId, outletId, available: false } })

      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1 })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('item_unavailable')
    })
  })

  describe('closed/settled session', () => {
    it('410s every cart call once the session is closed', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const added = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1 })
      const lineId = (added.body as TableCartBody).guests[0]?.lines[0]?.id

      const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
      const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Server Priya' } })
      const posToken = signPosToken({ id: staff.id, tenantId, outletId, name: staff.name })
      const closeRes = await authed(request(httpServer).post(`/pos/v1/tables/${tableId}/close-session`), posToken)
      expect(closeRes.status).toBe(200)

      const getRes = await authed(request(httpServer).get('/guest/v1/cart'), tokenA)
      expect(getRes.status).toBe(410)
      expect((getRes.body as ErrorBody).error.code).toBe('session_closed')

      const addRes = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId, quantity: 1 })
      expect(addRes.status).toBe(410)

      const patchRes = await authed(request(httpServer).patch(`/guest/v1/cart/lines/${lineId}`), tokenA).send({ quantity: 2 })
      expect(patchRes.status).toBe(410)

      const deleteRes = await authed(request(httpServer).delete(`/guest/v1/cart/lines/${lineId}`), tokenA)
      expect(deleteRes.status).toBe(410)
    })
  })

  describe('cross-tenant / cross-realm isolation', () => {
    it('rejects an admin-realm token on the guest cart routes (fifth disjoint realm, AD-17)', async () => {
      const tenantId = await createTenant(prisma)
      const adminToken = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@test.example' })

      const res = await authed(request(httpServer).get('/guest/v1/cart'), adminToken)
      expect(res.status).toBe(401)
    })

    it('rejects a pos-realm token on the guest cart routes', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
      const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Server Priya' } })
      const posToken = signPosToken({ id: staff.id, tenantId, outletId, name: staff.name })

      const res = await authed(request(httpServer).get('/guest/v1/cart'), posToken)
      expect(res.status).toBe(401)
    })

    it('a guest cannot add a menu item that belongs to another tenant', async () => {
      const tenantId = await createTenant(prisma)
      const otherTenantId = await createTenant(prisma, 'Other Tenant Co')
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(prisma, outletId, tableId)
      const { itemId: foreignItemId } = await createItemWithPrice(prisma, otherTenantId, 19000)

      const res = await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: foreignItemId, quantity: 1 })
      expect(res.status).toBe(400)
    })

    it('without a token, every cart call is rejected', async () => {
      const res = await request(httpServer).get('/guest/v1/cart')
      expect(res.status).toBe(401)
    })
  })
})
