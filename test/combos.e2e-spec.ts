// Combo menu (restiq-backend#160), end to end:
//  - owners build combos from slots (pick N, or one fixed item) and can edit
//    and delete (archive) them
//  - POS and guest menus list combos with outlet availability
//  - a combo is added as a parent line at the combo price plus one child line
//    per pick (price = the option's extra charge); bad picks are refused
//  - only the picks reach the kitchen, each tagged with the combo name
//  - the bill totals the combo correctly and the invoice prints it as one line
//  - guests can put a combo in the shared cart and place it
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signPosToken, uuidv7 } from '../src/platform'

interface ComboBody {
  id: string
  name: string
  priceMinor: number
  available: boolean
  slots: { id: string; name: string; pickCount: number; options: { id: string; itemId: string; itemName: string; upchargeMinor: number; available: boolean }[] }[]
}
interface OrderLineBody {
  id: string
  itemId: string | null
  comboId: string | null
  comboName: string | null
  parentLineId: string | null
  quantity: number
  unitPriceMinor: number
  modifiers: { modifierId: string; priceMinor: number }[]
}
interface OrderBody {
  id: string
  lines: OrderLineBody[]
}
interface ErrorBody {
  error: { code: string; message: string }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketEvent.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.invoice.deleteMany()
  await prisma.subscription.deleteMany()
  await prisma.appliedOp.deleteMany()
  await prisma.syncDeadLetter.deleteMany()
  await prisma.device.deleteMany()
  await prisma.enrolmentCode.deleteMany()
  await prisma.menuImportDraft.deleteMany()
  await prisma.itemOutletOverride.deleteMany()
  await prisma.comboSlotOption.deleteMany()
  await prisma.comboSlot.deleteMany()
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
  await prisma.ticket.deleteMany()
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

async function createTenant(prisma: PrismaClient, name = 'Guest Order Test Co'): Promise<string> {
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

async function createOutlet(prisma: PrismaClient, tenantId: string): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
  await prisma.outletCapability.create({ data: { tenantId, outletId: outlet.id, key: 'qr_ordering', enabled: true } })
  return outlet.id
}

async function createTable(prisma: PrismaClient, tenantId: string, outletId: string): Promise<string> {
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground' } })
  const table = await prisma.diningTable.create({ data: { tenantId, floorId: floor.id, label: 'T4', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 } })
  return table.id
}

async function createStaffToken(prisma: PrismaClient, tenantId: string, outletId: string): Promise<string> {
  const role = await prisma.role.upsert({ where: { tenantId_name: { tenantId, name: 'Cashier' } }, update: {}, create: { tenantId, name: 'Cashier', isSystem: true, isManager: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Asha' } })
  return signPosToken({ sessionVersion: 0, id: staff.id, tenantId, outletId, name: 'Asha' })
}

/** A thali menu: 2 mains and naan (Tandoor), 2 drinks (Bar), gulab jamun (Dessert), priced a la carte. */
async function createMenu(prisma: PrismaClient, tenantId: string, outletId: string) {
  const tandoor = await prisma.station.create({ data: { tenantId, outletId, name: 'Tandoor', ageingThresholdMinutes: 10 } })
  const bar = await prisma.station.create({ data: { tenantId, outletId, name: 'Bar', ageingThresholdMinutes: 10 } })
  const dessert = await prisma.station.create({ data: { tenantId, outletId, name: 'Dessert', ageingThresholdMinutes: 10 } })
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const make = async (name: string, shortName: string, priceMinor: number, stationId: string | null) => {
    const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name, shortName, stationId } })
    await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR' } })
    return item.id
  }
  const items = {
    butterChicken: await make('Butter chicken', 'BUTTER CHKN', 38000, tandoor.id),
    paneer: await make('Paneer tikka masala', 'PANEER TM', 34000, tandoor.id),
    naan: await make('Garlic naan', 'G NAAN', 9000, tandoor.id),
    lassi: await make('Mango lassi', 'M LASSI', 12000, bar.id),
    chai: await make('Masala chai', 'CHAI', 6000, bar.id),
    jamun: await make('Gulab jamun', 'JAMUN', 16000, dessert.id),
  }
  const group = await prisma.modifierGroup.create({ data: { tenantId, name: 'Spice', minSelections: 0, maxSelections: 1 } })
  const lessSpicy = await prisma.modifier.create({ data: { tenantId, groupId: group.id, name: 'Less spicy', priceMinor: 0n, sortOrder: 0 } })
  const extraButter = await prisma.modifier.create({ data: { tenantId, groupId: group.id, name: 'Extra butter', priceMinor: 2000n, sortOrder: 1 } })
  await prisma.itemModifierGroup.create({ data: { tenantId, itemId: items.butterChicken, groupId: group.id, sortOrder: 0 } })
  return { items, categoryId: category.id, tandoorId: tandoor.id, barId: bar.id, lessSpicy: lessSpicy.id, extraButter: extraButter.id }
}

function thaliBody(menu: Awaited<ReturnType<typeof createMenu>>) {
  return {
    name: 'Thali Meal',
    categoryId: menu.categoryId,
    priceMinor: 34900,
    currency: 'INR',
    slots: [
      { name: 'Main', pickCount: 1, options: [{ itemId: menu.items.butterChicken }, { itemId: menu.items.paneer }] },
      { name: 'Bread', pickCount: 2, options: [{ itemId: menu.items.naan }] },
      { name: 'Drink', pickCount: 1, options: [{ itemId: menu.items.lassi, upchargeMinor: 3000 }, { itemId: menu.items.chai }] },
      { name: 'Dessert', pickCount: 1, options: [{ itemId: menu.items.jamun }] },
    ],
  }
}

describe('combo menu (e2e)', () => {
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

  const authed = (req: request.Test, token: string) => req.set('Authorization', `Bearer ${token}`)

  async function setup() {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const menu = await createMenu(prisma, tenantId, outletId)
    const ownerToken = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@spiceroute.example' })
    const staffToken = await createStaffToken(prisma, tenantId, outletId)
    const created = await authed(request(httpServer).post('/admin/v1/menu/combos'), ownerToken).send(thaliBody(menu))
    expect(created.status).toBe(201)
    const combo = created.body as ComboBody
    const option = (slot: number, i = 0) => combo.slots[slot].options[i].id
    return { tenantId, outletId, tableId, menu, ownerToken, staffToken, combo, option }
  }

  async function openOrder(outletId: string, tableId: string, token: string): Promise<OrderBody> {
    return (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), token).send()).body as OrderBody
  }

  describe('owner combos', () => {
    it('creates, lists, edits and archives a combo built from slots', async () => {
      const { ownerToken, combo, menu } = await setup()
      expect(combo).toMatchObject({ name: 'Thali Meal', priceMinor: 34900, available: true })
      expect(combo.slots.map((s) => [s.name, s.pickCount, s.options.length])).toEqual([
        ['Main', 1, 2],
        ['Bread', 2, 1],
        ['Drink', 1, 2],
        ['Dessert', 1, 1],
      ])
      expect(combo.slots[2].options[0]).toMatchObject({ itemName: 'Mango lassi', upchargeMinor: 3000 })

      const edited = await authed(request(httpServer).put(`/admin/v1/menu/combos/${combo.id}`), ownerToken).send({ ...thaliBody(menu), priceMinor: 29900, slots: thaliBody(menu).slots.slice(0, 2) })
      expect(edited.status).toBe(200)
      expect(edited.body).toMatchObject({ priceMinor: 29900 })
      expect((edited.body as ComboBody).slots).toHaveLength(2)

      const clash = await authed(request(httpServer).post('/admin/v1/menu/combos'), ownerToken).send(thaliBody(menu))
      expect(clash.status).toBe(409)

      expect((await authed(request(httpServer).delete(`/admin/v1/menu/combos/${combo.id}`), ownerToken)).status).toBe(204)
      expect((await authed(request(httpServer).get('/admin/v1/menu/combos'), ownerToken)).body).toEqual([])
      // An archived combo's name is free again.
      expect((await authed(request(httpServer).post('/admin/v1/menu/combos'), ownerToken).send(thaliBody(menu))).status).toBe(201)
    })

    it("refuses another tenant's item", async () => {
      const { ownerToken, menu } = await setup()
      const other = await createTenant(prisma, 'Other Co')
      const otherToken = signAdminToken({ id: uuidv7(), tenantId: other, email: 'owner@other.example' })
      const res = await authed(request(httpServer).post('/admin/v1/menu/combos'), otherToken).send(thaliBody(menu))
      expect(res.status).toBe(400)
      expect(ownerToken).toBeTruthy()
    })
  })

  describe('POS', () => {
    it("lists combos on the menu and hides one whose fixed item is 86'd", async () => {
      const { staffToken, combo, menu, tenantId, outletId } = await setup()
      const before = await authed(request(httpServer).get('/pos/v1/menu'), staffToken)
      expect((before.body as { combos: ComboBody[] }).combos).toEqual([expect.objectContaining({ id: combo.id, available: true })])

      // Chai 86'd at this outlet: the drink slot still has lassi, so the combo stays.
      await prisma.itemOutletOverride.create({ data: { tenantId, outletId, itemId: menu.items.chai, available: false } })
      const partial = (await authed(request(httpServer).get('/pos/v1/menu'), staffToken)).body as { combos: ComboBody[] }
      expect(partial.combos[0].available).toBe(true)
      expect(partial.combos[0].slots[2].options[1].available).toBe(false)

      // The only dessert 86'd: the combo can't be sold.
      await prisma.menuItem.update({ where: { id: menu.items.jamun }, data: { available: false } })
      const after = (await authed(request(httpServer).get('/pos/v1/menu'), staffToken)).body as { combos: ComboBody[] }
      expect(after.combos[0].available).toBe(false)
    })

    it('adds a combo as a priced parent line with one child line per pick, fires only the picks, and bills it as one line', async () => {
      const { staffToken, combo, menu, outletId, tableId, option } = await setup()
      const order = await openOrder(outletId, tableId, staffToken)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/combos`), staffToken).send({
        comboId: combo.id,
        quantity: 1,
        selections: [
          { optionId: option(0, 0), modifierIds: [menu.extraButter] },
          { optionId: option(1), quantity: 2 },
          { optionId: option(2, 0) },
          // Dessert is fixed - left out and filled in by the server.
        ],
      })
      expect(res.status).toBe(201)
      const lines = (res.body as OrderBody).lines
      const parent = lines.find((l) => l.comboId)!
      expect(parent).toMatchObject({ itemId: null, comboName: 'Thali Meal', quantity: 1, unitPriceMinor: 34900, parentLineId: null })
      const children = lines.filter((l) => l.parentLineId === parent.id)
      expect(children.map((c) => [c.itemId, c.quantity, c.unitPriceMinor]).sort()).toEqual(
        [
          [menu.items.butterChicken, 1, 0],
          [menu.items.naan, 2, 0],
          [menu.items.lassi, 1, 3000],
          [menu.items.jamun, 1, 0],
        ].sort(),
      )
      expect(children.find((c) => c.itemId === menu.items.butterChicken)!.modifiers).toEqual([expect.objectContaining({ modifierId: menu.extraButter, priceMinor: 2000 })])

      // A pick inside the combo can't be edited or removed on its own.
      const lassiLine = children.find((c) => c.itemId === menu.items.lassi)!
      expect((await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${lassiLine.id}`), staffToken)).status).toBe(409)

      await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), staffToken).send({ status: 'sent' })
      const tandoorQueue = await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${menu.tandoorId}/queue`), staffToken)
      const tandoorLines = (tandoorQueue.body as { lines: { itemName: string; comboName: string | null; quantity: number }[] }[]).flatMap((t) => t.lines)
      expect(tandoorLines.map((l) => [l.itemName, l.quantity, l.comboName]).sort()).toEqual(
        [
          ['BUTTER CHKN', 1, 'Thali Meal'],
          ['G NAAN', 2, 'Thali Meal'],
        ].sort(),
      )
      const barQueue = await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${menu.barId}/queue`), staffToken)
      expect((barQueue.body as { lines: { itemName: string }[] }[]).flatMap((t) => t.lines).map((l) => l.itemName)).toEqual(['M LASSI'])

      const bill = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/bill`), staffToken).send()
      expect(bill.status).toBe(201)
      const billBody = bill.body as { id: string; subtotalMinor: number }
      // 349 combo + 30 lassi + 20 extra butter
      expect(billBody.subtotalMinor).toBe(39900)
      const invoice = await authed(request(httpServer).get(`/pos/v1/bills/${billBody.id}/invoice`), staffToken)
      expect((invoice.body as { lines: unknown[] }).lines).toEqual([
        {
          name: 'Thali Meal',
          quantity: 1,
          unitPriceMinor: 39900,
          lineTotalMinor: 39900,
          components: expect.arrayContaining(['Butter chicken (Extra butter)', '2× Garlic naan', 'Mango lassi', 'Gulab jamun']) as unknown,
        },
      ])
    })

    it('refuses a pick that does not fill its slot, and removing the combo removes its picks', async () => {
      const { staffToken, combo, outletId, tableId, option } = await setup()
      const order = await openOrder(outletId, tableId, staffToken)

      const short = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/combos`), staffToken).send({
        comboId: combo.id,
        quantity: 1,
        selections: [{ optionId: option(0) }, { optionId: option(1) }, { optionId: option(2) }],
      })
      expect(short.status).toBe(400)
      expect((short.body as ErrorBody).error.code).toBe('combo_selection_invalid')

      const two = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/combos`), staffToken).send({
        comboId: combo.id,
        quantity: 2,
        selections: [{ optionId: option(0, 1) }, { optionId: option(1), quantity: 2 }, { optionId: option(2, 1) }],
      })
      const lines = (two.body as OrderBody).lines
      const parent = lines.find((l) => l.comboId)!
      expect(parent.quantity).toBe(2)
      expect(lines.find((l) => l.parentLineId && l.itemId && l.quantity === 4)).toBeTruthy()

      const removed = await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${parent.id}`), staffToken)
      expect((removed.body as OrderBody).lines).toEqual([])
    })
  })

  describe('guest cart', () => {
    it('adds a combo to the shared cart at its full price and places it as combo lines', async () => {
      const { combo, outletId, tableId, option, menu } = await setup()
      const start = await request(httpServer).post('/guest/v1/sessions').send({ outletId, tableId, name: 'Rahul', phone: '+91 90000 11111' })
      const token = (start.body as { token: string }).token

      const guestMenu = await authed(request(httpServer).get('/guest/v1/menu'), token)
      expect((guestMenu.body as { combos: ComboBody[] }).combos.map((c) => c.id)).toEqual([combo.id])

      const cart = await authed(request(httpServer).post('/guest/v1/cart/combos'), token).send({
        comboId: combo.id,
        quantity: 1,
        selections: [{ optionId: option(0) }, { optionId: option(1), quantity: 2 }, { optionId: option(2, 0) }],
      })
      expect(cart.status).toBe(201)
      const cartBody = cart.body as { totalMinor: number; guests: { lines: { itemName: string; comboId: string; lineTotalMinor: number; components: string[] }[] }[] }
      expect(cartBody.totalMinor).toBe(37900)
      expect(cartBody.guests[0].lines).toEqual([expect.objectContaining({ itemName: 'Thali Meal', comboId: combo.id, lineTotalMinor: 37900 })])
      expect(cartBody.guests[0].lines[0].components).toContain('2× Garlic naan')

      const placed = await authed(request(httpServer).post('/guest/v1/orders'), token).send()
      expect(placed.status).toBe(201)
      const order = await prisma.orderLine.findMany({ where: { orderId: (placed.body as { orderId: string }).orderId } })
      const parent = order.find((l) => l.comboId)!
      expect(Number(parent.unitPriceMinor)).toBe(34900)
      expect(order.filter((l) => l.parentLineId === parent.id).map((l) => l.itemId).sort()).toEqual([menu.items.butterChicken, menu.items.naan, menu.items.lassi, menu.items.jamun].sort())
      expect(await prisma.cartLine.count()).toBe(0)
    })
  })
})
