// kitchen-display/CAP-1 success criteria, end to end (SPEC-kitchen-display,
// issue #67):
//  - firing a two-station order yields exactly two queued tickets with the
//    right lines on each
//  - re-firing (adding a line to an already-"sent" order) appends an ADD-ON
//    batch to the station's existing ticket, never a new unrelated one
//  - bump removes a ticket from its station queue and it appears bumped
//  - recall re-queues it at its source station, marked RECALLED
//  - expo re-consolidates an order's tickets across stations, with a
//    correct Waiting-On panel across a partial bump
//  - the all-day summary's counts derive only from real queued lines and
//    decrement as they bump
//  - an unrouted item still fires successfully, onto the outlet's default
//    station, or the synthetic "unrouted" grouping if the outlet has none
//  - every read/action is tenant-isolated (AD-5), same discipline as every
//    other realm
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
interface OrderBody {
  id: string
  status: 'open' | 'sent' | 'closed'
}
interface StationBody {
  id: string
  name: string
  ageingThresholdMinutes: number
}
interface TicketLineBody {
  id: string
  orderLineId: string
  itemId: string
  itemName: string
  quantity: number
  seatNumber: number | null
  addOnBatch: number
  voided: boolean
}
interface TicketBody {
  id: string
  orderId: string
  stationId: string | null
  stationName: string | null
  status: 'queued' | 'bumped'
  firedAt: string
  bumpedAt: string | null
  recallCount: number
  recalled: boolean
  lines: TicketLineBody[]
}
interface BumpedTicketBody extends TicketBody {
  recallHistory: string[]
}
interface ExpoOrderBody {
  orderId: string
  stations: { stationId: string | null; ready: boolean; tickets: TicketBody[] }[]
  waitingOn: TicketLineBody[]
}
interface AllDaySummaryEntryBody {
  itemId: string
  itemName: string
  quantity: number
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
  // qr-self-order/CAP-1 (guest realm, issue #68): table_sessions FKs to
  // dining_tables (RESTRICT) - wiped first so this helper is safe regardless
  // of what another e2e file left behind (same rationale as every sibling
  // spec's wipe(), e.g. tenant-onboarding.e2e-spec.ts).
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

async function createTable(prisma: PrismaClient, tenantId: string, outletId: string, label = 'T1'): Promise<string> {
  const floor = await prisma.floor.create({ data: { tenantId, outletId, name: 'Ground Floor' } })
  const table = await prisma.diningTable.create({
    data: { tenantId, floorId: floor.id, label, x: 0, y: 0, width: 10, height: 10, shape: 'square', seatCapacity: 4 },
  })
  return table.id
}

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const token = signPosToken({ id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function createStation(prisma: PrismaClient, tenantId: string, outletId: string, name: string, ageingThresholdMinutes = 10): Promise<string> {
  const station = await prisma.station.create({ data: { tenantId, outletId, name, ageingThresholdMinutes } })
  return station.id
}

async function createItem(prisma: PrismaClient, tenantId: string, priceMinor: number, opts?: { stationId?: string; shortName?: string }): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({
    data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: opts?.shortName ?? 'Itm', stationId: opts?.stationId ?? null },
  })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR', channel: 'dine_in' } })
  return item.id
}

describe('/kitchen/v1 ticket domain, routing, and fire-on-send (e2e)', () => {
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

  async function openOrder(outletId: string, tableId: string, token: string): Promise<string> {
    const res = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), token).send()
    return (res.body as OrderBody).id
  }

  async function addLine(orderId: string, itemId: string, token: string, seatNumber = 1): Promise<void> {
    const res = await authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), token).send({ itemId, quantity: 1, seatNumber })
    expect(res.status).toBe(201)
  }

  async function fire(orderId: string, token: string): Promise<void> {
    const res = await authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), token).send({ status: 'sent' })
    expect(res.status).toBe(200)
  }

  describe('fire and routing (CAP-1)', () => {
    it('fires exactly two tickets, one per station, with the right lines on each', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const grill = await createStation(prisma, tenantId, outletId, 'Grill')
      const tandoorItem = await createItem(prisma, tenantId, 19000, { stationId: tandoor, shortName: 'Naan' })
      const grillItem = await createItem(prisma, tenantId, 25000, { stationId: grill, shortName: 'Tikka' })

      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, tandoorItem, waiter.token)
      await addLine(orderId, grillItem, waiter.token)
      await fire(orderId, waiter.token)

      const stationsRes = await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations`), waiter.token)
      expect((stationsRes.body as StationBody[]).map((s) => s.name).sort()).toEqual(['Grill', 'Tandoor'])

      const tandoorQueue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      expect(tandoorQueue).toHaveLength(1)
      expect(tandoorQueue[0]?.lines.map((l) => l.itemId)).toEqual([tandoorItem])

      const grillQueue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${grill}/queue`), waiter.token)).body as TicketBody[]
      expect(grillQueue).toHaveLength(1)
      expect(grillQueue[0]?.lines.map((l) => l.itemId)).toEqual([grillItem])

      const allTickets = await prisma.ticket.findMany({ where: { orderId } })
      expect(allTickets).toHaveLength(2)
    })

    it('routes an unrouted item to the outlet default (oldest) station when the outlet has stations', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const first = await createStation(prisma, tenantId, outletId, 'Expo')
      await createStation(prisma, tenantId, outletId, 'Grill')
      const unroutedItem = await createItem(prisma, tenantId, 15000)

      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, unroutedItem, waiter.token)
      await fire(orderId, waiter.token)

      const queue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${first}/queue`), waiter.token)).body as TicketBody[]
      expect(queue).toHaveLength(1)
      expect(queue[0]?.lines[0]?.itemId).toBe(unroutedItem)
    })

    it('still fires successfully onto the synthetic "unrouted" grouping when the outlet has zero stations', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const item = await createItem(prisma, tenantId, 15000)

      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)

      const queue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/unrouted/queue`), waiter.token)).body as TicketBody[]
      expect(queue).toHaveLength(1)
      expect(queue[0]?.stationId).toBeNull()
    })

    it('re-fire after adding a line lands as an ADD-ON batch on the existing ticket, never a new one', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor })

      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)

      // pos/CAP-3: adding a line remains possible after the order is "sent".
      await addLine(orderId, item, waiter.token, 2)

      const queue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      expect(queue).toHaveLength(1)
      expect(queue[0]?.lines).toHaveLength(2)
      expect(queue[0]?.lines.map((l) => l.addOnBatch).sort()).toEqual([0, 1])

      const allTickets = await prisma.ticket.findMany({ where: { orderId } })
      expect(allTickets).toHaveLength(1)
    })

    it('opens a new ticket for a station whose prior ticket there was already bumped', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor })

      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)

      const [firstTicket] = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${firstTicket?.id}/bump`), waiter.token).send()

      await addLine(orderId, item, waiter.token, 2)

      const allTickets = await prisma.ticket.findMany({ where: { orderId }, orderBy: { firedAt: 'asc' } })
      expect(allTickets).toHaveLength(2)
      const queue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      expect(queue).toHaveLength(1)
      expect(queue[0]?.lines[0]?.addOnBatch).toBe(0)
    })
  })

  describe('bump and recall (CAP-2, CAP-4)', () => {
    it('bump removes a ticket from its station queue and it appears in the bumped list', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor })
      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)

      const [ticket] = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      const bumpRes = await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/bump`), waiter.token).send()
      expect(bumpRes.status).toBe(200)
      expect((bumpRes.body as TicketBody).status).toBe('bumped')

      const queueAfter = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      expect(queueAfter).toHaveLength(0)

      const bumped = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/bumped`), waiter.token)).body as BumpedTicketBody[]
      expect(bumped.map((t) => t.id)).toEqual([ticket?.id])
    })

    it('rejects bumping an already-bumped ticket', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor })
      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)
      const [ticket] = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]

      await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/bump`), waiter.token).send()
      const res = await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/bump`), waiter.token).send()
      expect(res.status).toBe(409)
      expect((res.body as ErrorBody).error.code).toBe('conflict')
    })

    it('recall re-queues a bumped ticket at its source station, marked recalled, with recall history retained', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor })
      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)
      const [ticket] = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/bump`), waiter.token).send()

      const recallRes = await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/recall`), waiter.token).send()
      expect(recallRes.status).toBe(200)
      const recalled = recallRes.body as TicketBody
      expect(recalled).toMatchObject({ status: 'queued', recalled: true, recallCount: 1 })

      const queueAfter = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      expect(queueAfter.map((t) => t.id)).toEqual([ticket?.id])

      // Bump it again, then check the bumped view retains its recall history.
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/bump`), waiter.token).send()
      const bumped = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/bumped`), waiter.token)).body as BumpedTicketBody[]
      expect(bumped[0]?.recallHistory).toHaveLength(1)
    })

    it('rejects recalling a ticket that is not bumped', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor })
      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)
      const [ticket] = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]

      const res = await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/recall`), waiter.token).send()
      expect(res.status).toBe(409)
    })
  })

  describe('expo consolidation (CAP-3)', () => {
    it('consolidates an order across stations with correct waiting-on across a partial bump', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const grill = await createStation(prisma, tenantId, outletId, 'Grill')
      const tandoorItem = await createItem(prisma, tenantId, 19000, { stationId: tandoor })
      const grillItem = await createItem(prisma, tenantId, 25000, { stationId: grill })
      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, tandoorItem, waiter.token)
      await addLine(orderId, grillItem, waiter.token)
      await fire(orderId, waiter.token)

      const beforeBump = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/expo`), waiter.token)).body as ExpoOrderBody[]
      expect(beforeBump).toHaveLength(1)
      expect(beforeBump[0]?.stations).toHaveLength(2)
      expect(beforeBump[0]?.waitingOn.map((l) => l.itemId).sort()).toEqual([grillItem, tandoorItem].sort())

      const tandoorTicket = beforeBump[0]?.stations.find((s) => s.stationId === tandoor)?.tickets[0]
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${tandoorTicket?.id}/bump`), waiter.token).send()

      const afterBump = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/expo`), waiter.token)).body as ExpoOrderBody[]
      const tandoorEntry = afterBump[0]?.stations.find((s) => s.stationId === tandoor)
      const grillEntry = afterBump[0]?.stations.find((s) => s.stationId === grill)
      expect(tandoorEntry?.ready).toBe(true)
      expect(grillEntry?.ready).toBe(false)
      expect(afterBump[0]?.waitingOn.map((l) => l.itemId)).toEqual([grillItem])
    })
  })

  describe('all-day summary (CAP-5)', () => {
    it('counts real queued lines only and decrements as they bump', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor, shortName: 'Naan' })
      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)

      const before = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/all-day-summary`), waiter.token)).body as AllDaySummaryEntryBody[]
      expect(before).toEqual([{ itemId: item, itemName: 'Naan', quantity: 1 }])

      const [ticket] = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]
      await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/bump`), waiter.token).send()

      const after = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/all-day-summary`), waiter.token)).body as AllDaySummaryEntryBody[]
      expect(after).toEqual([])
    })
  })

  describe('tenant isolation (AD-5)', () => {
    it('never returns or acts on another tenant\'s ticket', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const tandoor = await createStation(prisma, tenantId, outletId, 'Tandoor')
      const item = await createItem(prisma, tenantId, 19000, { stationId: tandoor })
      const orderId = await openOrder(outletId, tableId, waiter.token)
      await addLine(orderId, item, waiter.token)
      await fire(orderId, waiter.token)
      const [ticket] = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), waiter.token)).body as TicketBody[]

      const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
      const otherOutletId = await createOutlet(prisma, otherTenantId, 'Koramangala')
      const outsider = await createStaff(prisma, otherTenantId, otherOutletId, 'Rahul')

      const bumpRes = await authed(request(httpServer).post(`/kitchen/v1/tickets/${ticket?.id}/bump`), outsider.token).send()
      expect(bumpRes.status).toBe(404)

      const queueRes = await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/${tandoor}/queue`), outsider.token)
      expect(queueRes.status).toBe(404)
    })

    it('rejects a kitchen request with no pos session', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations`)
      expect(res.status).toBe(401)
    })
  })
})
