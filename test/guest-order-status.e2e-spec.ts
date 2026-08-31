// qr-self-order/CAP-6 success criteria, end to end (SPEC-qr-self-order,
// story 6, issue #81):
//  - placed order: step 'placed', 'accepted'/'preparing'/'ready' unreached
//  - once fired (placement fires immediately - CAP-4), tickets exist so the
//    order is at least 'preparing' (the honest accepted/preparing collapse -
//    see src/guest/orders/orders.service.ts's buildOrderStatusView)
//  - bumping only SOME of an order's tickets: still 'preparing', not 'ready'
//  - bumping every ticket: 'ready', with a real bumpedAt on the ready step
//  - GET .../session/orders lists every order the session placed, each with
//    its own stepper
//  - another session's order id: 404 (never reveals whether it exists)
//  - a closed session: 410, per the guest convention (same as placement)
//  - cross-tenant isolation
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
interface GuestOrderStepBody {
  step: 'placed' | 'accepted' | 'preparing' | 'ready'
  reachedAt: string | null
}
interface GuestOrderStatusBody {
  orderId: string
  tableId: string | null
  step: 'placed' | 'accepted' | 'preparing' | 'ready'
  steps: GuestOrderStepBody[]
}
interface GuestSessionOrdersBody {
  sessionId: string
  orders: GuestOrderStatusBody[]
}
interface PlacedOrderBody {
  orderId: string
}
interface TicketBody {
  id: string
  lines: { itemId: string }[]
}
interface StartResult {
  token: string
  pin: string
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

async function createTenant(prisma: PrismaClient, name = 'Guest Status Test Co'): Promise<string> {
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
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Guest Status Test Brand' } })
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
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR' } })
  return item.id
}

describe('/guest/v1 order status tracking (e2e)', () => {
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

  async function startSession(outletId: string, tableId: string): Promise<StartResult['session'] & { token: string }> {
    const startRes = await request(httpServer)
      .post('/guest/v1/sessions')
      .send({ outletId, tableId, name: 'Asha', phone: '+91 90000 11111' })
    const { token, session } = startRes.body as StartResult
    return { ...session, token }
  }

  function stepsByName(body: GuestOrderStatusBody): Record<string, GuestOrderStepBody> {
    return Object.fromEntries(body.steps.map((s) => [s.step, s]))
  }

  describe('the lifecycle walk', () => {
    it('reports placed -> preparing -> ready as the kitchen bumps the order\'s tickets', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const grill = await createStation(prisma, tenantId, outletId, 'Grill')
      const tandoorItem = await createItemWithPrice(prisma, tenantId, 19000, { stationId: tandoor, shortName: 'Naan' })
      const grillItem = await createItemWithPrice(prisma, tenantId, 25000, { stationId: grill, shortName: 'Tikka' })

      const { token } = await startSession(outletId, tableId)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: tandoorItem, quantity: 1 })
      await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: grillItem, quantity: 1 })
      const placed = (await authed(request(httpServer).post('/guest/v1/orders'), token).send({})).body as PlacedOrderBody

      // Placement fires immediately (CAP-4), so by the time the guest can ask
      // for status the tickets already exist - the honest model has no
      // separate "accepted, not yet preparing" window (see
      // buildOrderStatusView's doc comment), so the very first read is
      // already 'preparing'.
      const firstRead = await authed(request(httpServer).get(`/guest/v1/orders/${placed.orderId}/status`), token)
      expect(firstRead.status).toBe(200)
      const firstBody = firstRead.body as GuestOrderStatusBody
      expect(firstBody.orderId).toBe(placed.orderId)
      expect(firstBody.step).toBe('preparing')
      const firstSteps = stepsByName(firstBody)
      expect(firstSteps.placed?.reachedAt).not.toBeNull()
      expect(firstSteps.accepted?.reachedAt).not.toBeNull()
      expect(firstSteps.preparing?.reachedAt).not.toBeNull()
      expect(firstSteps.ready?.reachedAt).toBeNull()

      const staffToken = await createStaff(prisma, tenantId, outletId, 'Server Priya')
      const tandoorQueue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), staffToken)).body as TicketBody[]
      const grillQueue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${grill}/queue`), staffToken)).body as TicketBody[]
      expect(tandoorQueue).toHaveLength(1)
      expect(grillQueue).toHaveLength(1)

      // Bump one of the two tickets - the order must NOT read as ready yet.
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${tandoorQueue[0].id}/bump`), staffToken)
      const midRead = await authed(request(httpServer).get(`/guest/v1/orders/${placed.orderId}/status`), token)
      const midBody = midRead.body as GuestOrderStatusBody
      expect(midBody.step).toBe('preparing')
      expect(stepsByName(midBody).ready?.reachedAt).toBeNull()

      // Bump the second (last) ticket - now every ticket is bumped.
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${grillQueue[0].id}/bump`), staffToken)
      const lastRead = await authed(request(httpServer).get(`/guest/v1/orders/${placed.orderId}/status`), token)
      const lastBody = lastRead.body as GuestOrderStatusBody
      expect(lastBody.step).toBe('ready')
      expect(stepsByName(lastBody).ready?.reachedAt).not.toBeNull()
    })
  })

  describe('GET /guest/v1/session/orders', () => {
    it('lists every order the table session placed, each with its own stepper', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const item = await createItemWithPrice(prisma, tenantId, 15000)
      const { token, sessionId } = await startSession(outletId, tableId)
      const staffToken = await createStaff(prisma, tenantId, outletId, 'Server Priya')

      await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: item, quantity: 1 })
      const firstOrder = (await authed(request(httpServer).post('/guest/v1/orders'), token).send({})).body as PlacedOrderBody
      // "orders_one_active_per_table" (one non-closed order per table at a
      // time - pos/CAP-2 constraint) means a second order can only be placed
      // on the same table once the first is closed - the same thing a staff
      // member would do after settling the first round's bill.
      await authed(request(httpServer).patch(`/pos/v1/orders/${firstOrder.orderId}/status`), staffToken).send({ status: 'closed' })
      await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: item, quantity: 2 })
      const secondOrder = (await authed(request(httpServer).post('/guest/v1/orders'), token).send({})).body as PlacedOrderBody

      const res = await authed(request(httpServer).get('/guest/v1/session/orders'), token)
      expect(res.status).toBe(200)
      const body = res.body as GuestSessionOrdersBody
      expect(body.sessionId).toBe(sessionId)
      const ids = body.orders.map((o) => o.orderId)
      expect(ids).toEqual(expect.arrayContaining([firstOrder.orderId, secondOrder.orderId]))
      expect(body.orders.every((o) => o.step === 'preparing')).toBe(true)
    })
  })

  describe('isolation and error convention', () => {
    it('404s status for an order belonging to a different session', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableA = await createTable(prisma, tenantId, outletId, 'T1')
      const tableB = await createTable(prisma, tenantId, outletId, 'T2')
      await enableQrOrdering(prisma, tenantId, outletId)
      const item = await createItemWithPrice(prisma, tenantId, 15000)

      const sessionA = await startSession(outletId, tableA)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), sessionA.token).send({ itemId: item, quantity: 1 })
      const placedA = (await authed(request(httpServer).post('/guest/v1/orders'), sessionA.token).send({})).body as PlacedOrderBody

      const sessionB = await startSession(outletId, tableB)
      const res = await authed(request(httpServer).get(`/guest/v1/orders/${placedA.orderId}/status`), sessionB.token)
      expect(res.status).toBe(404)
      expect((res.body as ErrorBody).error.code).toBe('not_found')
    })

    it('404s status for a nonexistent order id', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const { token } = await startSession(outletId, tableId)

      const res = await authed(request(httpServer).get(`/guest/v1/orders/${uuidv7()}/status`), token)
      expect(res.status).toBe(404)
      expect((res.body as ErrorBody).error.code).toBe('not_found')
    })

    it('410s status and the session-orders list once the session is closed', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      await enableQrOrdering(prisma, tenantId, outletId)
      const item = await createItemWithPrice(prisma, tenantId, 15000)
      const { token } = await startSession(outletId, tableId)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: item, quantity: 1 })
      const placed = (await authed(request(httpServer).post('/guest/v1/orders'), token).send({})).body as PlacedOrderBody

      const staffToken = await createStaff(prisma, tenantId, outletId, 'Server Priya')
      const closeRes = await authed(request(httpServer).post(`/pos/v1/tables/${tableId}/close-session`), staffToken)
      expect(closeRes.status).toBe(200)

      const statusRes = await authed(request(httpServer).get(`/guest/v1/orders/${placed.orderId}/status`), token)
      expect(statusRes.status).toBe(410)
      expect((statusRes.body as ErrorBody).error.code).toBe('session_closed')

      const listRes = await authed(request(httpServer).get('/guest/v1/session/orders'), token)
      expect(listRes.status).toBe(410)
      expect((listRes.body as ErrorBody).error.code).toBe('session_closed')
    })

    it('rejects without a guest token', async () => {
      const res = await request(httpServer).get(`/guest/v1/orders/${uuidv7()}/status`)
      expect(res.status).toBe(401)
    })
  })

  describe('cross-tenant isolation', () => {
    it('one tenant\'s guest cannot read another tenant\'s order status', async () => {
      const tenantA = await createTenant(prisma, 'Tenant A')
      const outletA = await createOutlet(prisma, tenantA)
      const tableA = await createTable(prisma, tenantA, outletA)
      await enableQrOrdering(prisma, tenantA, outletA)
      const itemA = await createItemWithPrice(prisma, tenantA, 15000)
      const { token: tokenA } = await startSession(outletA, tableA)
      await authed(request(httpServer).post('/guest/v1/cart/lines'), tokenA).send({ itemId: itemA, quantity: 1 })
      const placedA = (await authed(request(httpServer).post('/guest/v1/orders'), tokenA).send({})).body as PlacedOrderBody

      const tenantB = await createTenant(prisma, 'Tenant B')
      const outletB = await createOutlet(prisma, tenantB)
      const tableB = await createTable(prisma, tenantB, outletB)
      await enableQrOrdering(prisma, tenantB, outletB)
      const { token: tokenB } = await startSession(outletB, tableB)

      const res = await authed(request(httpServer).get(`/guest/v1/orders/${placedA.orderId}/status`), tokenB)
      expect(res.status).toBe(404)
      expect((res.body as ErrorBody).error.code).toBe('not_found')
    })
  })
})
