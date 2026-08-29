// qr-self-order/CAP-4 success criteria, end to end (SPEC-qr-self-order,
// story 4, issue #77):
//  - placing the table order converts the session's shared cart into a real
//    Order/OrderLine set - source 'qr', sessionId set, ownerId null (never a
//    faked staff owner), guest labels on each line, seat numbers
//    auto-assigned by guest join order
//  - it fires through the same open->sent kitchen transition as a staff
//    order: real Tickets exist, correctly routed to each item's station
//  - the placed order shows up in the POS open-orders list like any other
//    order (AD-18: zero special-casing beyond the labels)
//  - placing consumes the cart - it reads back empty afterwards
//  - an empty cart cannot be placed; a closed/settled session 410s placement
//  - cross-tenant isolation: one tenant's guest order never appears in
//    another tenant's POS view
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface PlacedOrderLineBody {
  id: string
  itemId: string
  itemName: string
  quantity: number
  unitPriceMinor: number
  seatNumber: number | null
  guestId: string
  guestName: string
  modifiers: { id: string; name: string; priceMinor: number }[]
}
interface PlacedOrderBody {
  orderId: string
  tableId: string
  status: 'sent'
  source: 'qr'
  sessionId: string
  lines: PlacedOrderLineBody[]
}
interface OrderBody {
  id: string
  ownerId: string | null
  status: 'open' | 'sent' | 'closed'
  source: 'pos' | 'qr'
  sessionId: string | null
  lines: { itemId: string; guestId: string | null; guestName: string | null; addedByStaffId: string | null; seatNumber: number | null }[]
}
interface TicketLineBody {
  itemId: string
  quantity: number
  guestName: string | null
}
interface TicketBody {
  stationId: string | null
  lines: TicketLineBody[]
}
interface TableCartBody {
  guests: { guestId: string; lines: unknown[] }[]
  totalMinor: number
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

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Koramangala'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Guest Order Test Brand' } })
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

async function createStation(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<string> {
  const station = await prisma.station.create({ data: { tenantId, outletId, name, ageingThresholdMinutes: 10 } })
  return station.id
}

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<string> {
  const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  return signPosToken({ id: staff.id, tenantId, outletId, name })
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number, opts?: { stationId?: string; shortName?: string }): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({
    data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: opts?.shortName ?? 'Itm', available: true, stationId: opts?.stationId ?? null },
  })
  // Channel omitted (null = unscoped) so it applies to the guest cart/order
  // placement's 'qr' pricing channel the same as it would to any other.
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR' } })
  return item.id
}

describe('/guest/v1/orders order placement into the real pipeline (e2e)', () => {
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

  async function startAndJoin(outletId: string, tableId: string): Promise<{ tokenA: string; tokenB: string; sessionId: string; pin: string }> {
    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    const { token: tokenA, pin, session } = startRes.body as StartResult
    const joinRes = await request(httpServer).post('/guest/v1/sessions/join').send({ outletId, tableId, pin, name: 'Rohan' })
    const { token: tokenB } = joinRes.body as JoinResult
    return { tokenA, tokenB, sessionId: session.sessionId, pin }
  }

  describe('placement success', () => {
    it('converts the shared cart into a real Order with guest attribution, auto-assigned seats, and fires kitchen tickets routed by station', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const grill = await createStation(prisma, tenantId, outletId, 'Grill')
      const tandoorItem = await createItemWithPrice(prisma, tenantId, 19000, { stationId: tandoor, shortName: 'Naan' })
      const grillItem = await createItemWithPrice(prisma, tenantId, 25000, { stationId: grill, shortName: 'Tikka' })

      const { tokenA, tokenB, sessionId } = await startAndJoin(outletId, tableId)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: tandoorItem, quantity: 2 })
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenB).send({ itemId: grillItem, quantity: 1 })

      const placeRes = await authed(request(httpServer).post('/guest/v1/orders'), tokenA).send({})
      expect(placeRes.status).toBe(201)
      const placed = placeRes.body as PlacedOrderBody
      expect(placed.tableId).toBe(tableId)
      expect(placed.status).toBe('sent')
      expect(placed.source).toBe('qr')
      expect(placed.sessionId).toBe(sessionId)
      expect(placed.lines).toHaveLength(2)

      const ashaLine = placed.lines.find((l) => l.itemId === tandoorItem)
      const rohanLine = placed.lines.find((l) => l.itemId === grillItem)
      expect(ashaLine).toMatchObject({ guestName: 'Asha', quantity: 2, unitPriceMinor: 19000, seatNumber: 1 })
      expect(rohanLine).toMatchObject({ guestName: 'Rohan', quantity: 1, unitPriceMinor: 25000, seatNumber: 2 })

      // Real Order/OrderLine rows, same pipeline as a staff order (AD-18) -
      // no staff owner, no staff adder, source discriminator set.
      const order = await prisma.order.findUnique({ where: { id: placed.orderId } })
      expect(order?.status).toBe('sent')
      expect(order?.source).toBe('qr')
      expect(order?.ownerId).toBeNull()
      expect(order?.sessionId).toBe(sessionId)
      const lines = await prisma.orderLine.findMany({ where: { orderId: placed.orderId } })
      expect(lines.every((l) => l.addedByStaffId === null)).toBe(true)
      expect(lines.every((l) => l.guestId !== null && l.guestName !== null)).toBe(true)

      // Fired through the real open->sent kitchen transition - real Tickets
      // exist, correctly routed by each item's station.
      const staffToken = await createStaff(prisma, tenantId, outletId, 'Server Priya')
      const tandoorQueue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), staffToken)).body as TicketBody[]
      expect(tandoorQueue).toHaveLength(1)
      expect(tandoorQueue[0]?.lines).toEqual([expect.objectContaining({ itemId: tandoorItem, quantity: 2, guestName: 'Asha' })])

      const grillQueue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${grill}/queue`), staffToken)).body as TicketBody[]
      expect(grillQueue).toHaveLength(1)
      expect(grillQueue[0]?.lines).toEqual([expect.objectContaining({ itemId: grillItem, quantity: 1, guestName: 'Rohan' })])
    })

    it('shows the placed order in the POS open-orders list, like any other order', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const item = await createItemWithPrice(prisma, tenantId, 15000)
      const { tokenA } = await startAndJoin(outletId, tableId)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: item, quantity: 1 })
      const placed = (await authed(request(httpServer).post('/guest/v1/orders'), tokenA).send({})).body as PlacedOrderBody

      const staffToken = await createStaff(prisma, tenantId, outletId, 'Server Priya')
      const listRes = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`), staffToken)
      expect(listRes.status).toBe(200)
      const orders = listRes.body as OrderBody[]
      const found = orders.find((o) => o.id === placed.orderId)
      expect(found).toMatchObject({ status: 'sent', source: 'qr', ownerId: null })
      expect(found?.lines[0]).toMatchObject({ itemId: item, guestName: 'Asha' })
    })

    it('consumes the cart - it reads back empty after placement', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const item = await createItemWithPrice(prisma, tenantId, 15000)
      const { tokenA } = await startAndJoin(outletId, tableId)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: item, quantity: 1 })

      const placeRes = await authed(request(httpServer).post('/guest/v1/orders'), tokenA).send({})
      expect(placeRes.status).toBe(201)

      const cartRes = await authed(request(httpServer).get('/guest/v1/cart'), tokenA)
      expect(cartRes.status).toBe(200)
      const cart = cartRes.body as TableCartBody
      expect(cart.guests).toHaveLength(0)
      expect(cart.totalMinor).toBe(0)
      expect(await prisma.cartLine.count()).toBe(0)
    })
  })

  describe('validation', () => {
    it('rejects placing an empty cart', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { tokenA } = await startAndJoin(outletId, tableId)

      const res = await authed(request(httpServer).post('/guest/v1/orders'), tokenA).send({})
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('empty_cart')
      expect(await prisma.order.count()).toBe(0)
    })

    it('410s placement once the session is closed', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const item = await createItemWithPrice(prisma, tenantId, 15000)
      const { tokenA } = await startAndJoin(outletId, tableId)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: item, quantity: 1 })

      const staffToken = await createStaff(prisma, tenantId, outletId, 'Server Priya')
      const closeRes = await authed(request(httpServer).post(`/pos/v1/tables/${tableId}/close-session`), staffToken)
      expect(closeRes.status).toBe(200)

      const res = await authed(request(httpServer).post('/guest/v1/orders'), tokenA).send({})
      expect(res.status).toBe(410)
      expect((res.body as ErrorBody).error.code).toBe('session_closed')
      expect(await prisma.order.count()).toBe(0)
    })
  })

  describe('cross-tenant isolation', () => {
    it('a guest order placed for one tenant never appears in another tenant\'s POS open-orders list', async () => {
      const tenantA = await createTenant(prisma, 'Tenant A')
      const outletA = await createOutlet(prisma, tenantA)
      const tableA = await createTable(prisma, tenantA, outletA)
      await enableQrOrdering(prisma, tenantA, outletA)
      const itemA = await createItemWithPrice(prisma, tenantA, 15000)
      const { tokenA } = await startAndJoin(outletA, tableA)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: itemA, quantity: 1 })
      await authed(request(httpServer).post('/guest/v1/orders'), tokenA).send({})

      const tenantB = await createTenant(prisma, 'Tenant B')
      const outletB = await createOutlet(prisma, tenantB)
      const staffTokenB = await createStaff(prisma, tenantB, outletB, 'Server Bee')

      const listRes = await authed(request(httpServer).get(`/pos/v1/outlets/${outletB}/orders`), staffTokenB)
      expect(listRes.status).toBe(200)
      expect(listRes.body as OrderBody[]).toEqual([])
    })

    it('without a guest token, placement is rejected', async () => {
      const res = await request(httpServer).post('/guest/v1/orders').send({})
      expect(res.status).toBe(401)
    })
  })
})
