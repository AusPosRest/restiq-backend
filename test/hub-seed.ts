// Hub mode (#293) test data: one tenant with an outlet, a cashier with an
// argon2 PIN hash and one priced menu item. Shared by src/hub/hub.spec.ts and
// scripts/smoke-hub.ts. #300 adds the sale fixture (table, modifiers, combo,
// station, manager) and the sale the op recorder tests ring up on the hub.
import type { PGlite } from '@electric-sql/pglite'
import * as argon2 from 'argon2'
import request from 'supertest'
import type { PrismaClient } from '../src/db/client'
import { APP_ROLE } from '../src/hub/store'
import { uuidv7 } from '../src/platform'

export const HUB_PIN = '4321'
export const MANAGER_PIN = '8765'

export interface HubSeed {
  tenantId: string
  outletId: string
  staffId: string
  itemId: string
}

/** The seed rows, through any client that can write them (the cloud's, or PGlite's as superuser). */
export async function seedTenantRows(prisma: PrismaClient, name: string): Promise<HubSeed> {
  const tenantId = uuidv7()
  await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name,
      registeredAddress: '1 Test Street',
      contactName: 'Test Contact',
      contactEmail: `${tenantId}@test.example`,
      contactPhone: '+91 90000 00000',
      country: 'IN',
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  const brand = await prisma.brand.create({ data: { tenantId, name } })
  const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: `${name} Outlet`, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
  const role = await prisma.role.create({ data: { tenantId, name: 'Cashier', isSystem: true, isManager: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: `${name} Cashier`, pinHash: await argon2.hash(HUB_PIN), pinIssuedAt: new Date() } })
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `${name} Dosa`, shortName: 'Dosa' } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: 12000n, currency: 'INR', channel: 'dine_in' } })
  return { tenantId, outletId: outlet.id, staffId: staff.id, itemId: item.id }
}

/** Seeds as PGlite's superuser (as the bootstrap import will), then hands the connection back to the app role. */
export async function seedHubTenant(pg: PGlite, prisma: PrismaClient, name: string): Promise<HubSeed> {
  await pg.exec('RESET ROLE')
  try {
    return await seedTenantRows(prisma, name)
  } finally {
    await pg.exec(`SET ROLE ${APP_ROLE}`)
  }
}

export interface SaleFixture extends HubSeed {
  tableId: string
  stationId: string
  coffeeId: string
  gheeId: string
  comboId: string
  comboOptionId: string
  managerId: string
}

/** A table, a station, a second item, a modifier on both items, a one-slot combo and a manager (PIN MANAGER_PIN). */
export async function seedSaleFixture(prisma: PrismaClient, seed: HubSeed): Promise<SaleFixture> {
  const { tenantId, outletId } = seed
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
  const table = await prisma.diningTable.create({ data: { tenantId, floorId: floor.id, label: 'T1', x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 } })
  const station = await prisma.station.create({ data: { tenantId, outletId, name: 'Grill', ageingThresholdMinutes: 10 } })
  const dosa = await prisma.menuItem.update({ where: { id: seed.itemId }, data: { stationId: station.id } })
  const coffee = await prisma.menuItem.create({ data: { tenantId, categoryId: dosa.categoryId, name: 'Filter coffee', shortName: 'Coffee', stationId: station.id } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: coffee.id, priceMinor: 4500n, currency: 'INR', channel: 'dine_in' } })
  const group = await prisma.modifierGroup.create({ data: { tenantId, name: 'Extras', minSelections: 0, maxSelections: 2 } })
  const ghee = await prisma.modifier.create({ data: { tenantId, groupId: group.id, name: 'Ghee', priceMinor: 1500n, sortOrder: 0 } })
  for (const itemId of [dosa.id, coffee.id]) await prisma.itemModifierGroup.create({ data: { tenantId, itemId, groupId: group.id, sortOrder: 0 } })
  const combo = await prisma.combo.create({ data: { tenantId, name: 'Tiffin', priceMinor: 15000n, currency: 'INR' } })
  const slot = await prisma.comboSlot.create({ data: { tenantId, comboId: combo.id, name: 'Main', pickCount: 1, sortOrder: 0 } })
  await prisma.comboSlotOption.create({ data: { tenantId, slotId: slot.id, itemId: coffee.id, sortOrder: 0 } })
  const option = await prisma.comboSlotOption.create({ data: { tenantId, slotId: slot.id, itemId: dosa.id, upchargeMinor: 500n, sortOrder: 1 } })
  const role = await prisma.role.create({ data: { tenantId, name: 'Manager', isSystem: true, isManager: true } })
  const manager = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Meera', pinHash: await argon2.hash(MANAGER_PIN), pinIssuedAt: new Date() } })
  return { ...seed, tableId: table.id, stationId: station.id, coffeeId: coffee.id, gheeId: ghee.id, comboId: combo.id, comboOptionId: option.id, managerId: manager.id }
}

/** Every op type, in the order the sale below records them. */
export const SALE_OP_TYPES = [
  'clock.in',
  'shift.open',
  'shift.cash_movement',
  'order.create',
  'order.line.add',
  'order.line.add',
  'order.combo.add',
  'order.status',
  'ticket.bump',
  'ticket.recall',
  'ticket.bump',
  'order.line.void',
  'order.line.add',
  'order.line.update',
  'order.line.remove',
  'order.create',
  'order.discard',
  'order.create',
  'order.transfer',
  'bill.create',
  'bill.finalize',
  'shift.close',
  'clock.out',
]

interface Line {
  id: string
  itemId: string | null
}

/** A whole shift on the hub, through its HTTP API: every mapped write once or more. Returns the table order's finalized bill. */
export async function ringUpSale(http: Parameters<typeof request>[0], f: SaleFixture): Promise<{ billId: string }> {
  const login = await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin: HUB_PIN }).expect(200)
  const auth = { Authorization: `Bearer ${(login.body as { token: string }).token}` }
  const post = (path: string, body?: object) => request(http).post(path).set(auth).send(body)

  const shift = (await post('/pos/v1/shifts', { outletId: f.outletId, floatMinor: 50000 }).expect(201)).body as { id: string }
  await post(`/pos/v1/shifts/${shift.id}/cash-movements`, { type: 'paid_out', amountMinor: 2000, reason: 'Milk' }).expect(201)

  const order = (await post(`/pos/v1/outlets/${f.outletId}/tables/${f.tableId}/order`).expect(200)).body as { id: string }
  await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.itemId, quantity: 2, modifierIds: [f.gheeId], note: ' less spicy ' }).expect(201)
  const withCoffee = (await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.coffeeId, quantity: 1, seatNumber: 2 }).expect(201)).body as { lines: Line[] }
  const coffeeLine = withCoffee.lines.find((l) => l.itemId === f.coffeeId)!
  await post(`/pos/v1/orders/${order.id}/combos`, { comboId: f.comboId, quantity: 1, selections: [{ optionId: f.comboOptionId, modifierIds: [f.gheeId] }] }).expect(201)
  // Opening the same table again hands back the open order: no second order.create.
  await post(`/pos/v1/outlets/${f.outletId}/tables/${f.tableId}/order`).expect(200)
  await request(http).patch(`/pos/v1/orders/${order.id}/status`).set(auth).send({ status: 'sent' }).expect(200)

  const queue = (await request(http).get(`/kitchen/v1/outlets/${f.outletId}/stations/${f.stationId}/queue`).set(auth).expect(200)).body as { id: string }[]
  if (queue.length !== 1) throw new Error(`expected one queued ticket, got ${queue.length}`)
  await post(`/kitchen/v1/tickets/${queue[0].id}/bump`).expect(200)
  await post(`/kitchen/v1/tickets/${queue[0].id}/recall`).expect(200)
  await post(`/kitchen/v1/tickets/${queue[0].id}/bump`).expect(200)

  await post(`/pos/v1/orders/${order.id}/lines/${coffeeLine.id}/void`, { managerPin: MANAGER_PIN, reason: ' Spilled ' }).expect(200)
  const extra = ((await post(`/pos/v1/orders/${order.id}/lines`, { itemId: f.coffeeId, quantity: 1 }).expect(201)).body as { lines: Line[] }).lines.find(
    (l) => l.itemId === f.coffeeId && l.id !== coffeeLine.id,
  )!
  await request(http).patch(`/pos/v1/orders/${order.id}/lines/${extra.id}`).set(auth).send({ quantity: 3 }).expect(200)
  await request(http).delete(`/pos/v1/orders/${order.id}/lines/${extra.id}`).set(auth).expect(200)

  const mistake = (await post(`/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)).body as { id: string }
  await request(http).delete(`/pos/v1/orders/${mistake.id}`).set(auth).expect(204)
  const handover = (await post(`/pos/v1/outlets/${f.outletId}/counter-orders`).expect(201)).body as { id: string }
  await post(`/pos/v1/orders/${handover.id}/transfer`, { newOwnerStaffId: f.managerId, reason: 'Shift change' }).expect(201)

  const bill = (await post(`/pos/v1/orders/${order.id}/bill`).expect(201)).body as { id: string; totalMinor: number }
  const due = bill.totalMinor
  await post(`/pos/v1/bills/${bill.id}/finalize`, {
    managerPin: MANAGER_PIN, // not needed here; must never reach the op
    tenders: [
      { method: 'cash', amountMinor: 1000, tenderedMinor: 1000 },
      { method: 'cash', amountMinor: due - 1000, tenderedMinor: due },
    ],
  }).expect(200)

  await post(`/pos/v1/shifts/${shift.id}/close`, { countedMinor: 60000 }).expect(200)
  await post('/pos/v1/clock/out').expect(200)
  return { billId: bill.id }
}
