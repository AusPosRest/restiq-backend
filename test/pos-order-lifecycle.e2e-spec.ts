// restiq-backend#210 - POS till order lifecycle fixes from the QA pass:
//  - CU-12: special instructions are stored on the line and reach the ticket
//  - SE-22: orders carry owner / adder names, not just ids
//  - CU-15: items added after the first send wait on the till until Send to
//    kitchen; an unsent line can be removed, a sent one only voided with a
//    manager PIN (and then it leaves the bill and is struck on the ticket)
//  - PE-16/CU-14/CU-27: an empty order can be discarded
//  - CU-17: a counter order settled from Open orders (never sent) still
//    reaches the kitchen
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string }
}
interface LineBody {
  id: string
  quantity: number
  note: string | null
  addedByStaffName: string | null
  sentToKitchen: boolean
}
interface OrderBody {
  id: string
  ownerId: string
  ownerName: string | null
  status: 'open' | 'sent' | 'closed'
  tokenNumber: number | null
  lines: LineBody[]
}
interface BillBody {
  id: string
  totalMinor: number
  subtotalMinor: number
}
interface TableMapBody {
  tableId: string
  status: 'occupied' | 'empty'
  ownerName: string | null
  guestSessionOpen: boolean
}
async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.printJob.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.billShare.deleteMany()
  // tenders FK to payment_intents (RESTRICT), payment_intents FK to bills and
  // staff_users - so tenders, then intents, then everything they point at.
  await prisma.tender.deleteMany()
  await prisma.paymentIntent.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
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
  await prisma.ticketEvent.deleteMany()
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


async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm' } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR', channel: 'dine_in' } })
  return item.id
}


async function createStaff(
  prisma: PrismaClient,
  tenantId: string,
  outletId: string,
  name: string,
  opts?: { role?: 'Cashier' | 'Manager' | 'Waiter'; pin?: string },
): Promise<{ id: string; token: string }> {
  const roleName = opts?.role ?? 'Cashier'
  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId, name: roleName } },
    update: {},
    create: { tenantId, name: roleName, isSystem: true, isManager: roleName === 'Manager' },
  })
  const pinHash = opts?.pin ? await argon2.hash(opts.pin) : undefined
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name, pinHash } })
  return { id: staff.id, token: signPosToken({ sessionVersion: 0, id: staff.id, tenantId, outletId, name }) }
}

describe('/pos/v1 till order lifecycle (e2e, restiq-backend#210)', () => {
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

  async function setUp() {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
    const itemId = await createItemWithPrice(prisma, tenantId, 10000)
    return { tenantId, outletId, tableId, waiter, itemId }
  }

  const openTable = async (outletId: string, tableId: string, token: string) =>
    (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), token).send()).body as OrderBody
  const addLine = async (orderId: string, token: string, body: Record<string, unknown>) =>
    authed(request(httpServer).post(`/pos/v1/orders/${orderId}/lines`), token).send({ quantity: 1, ...body })
  const send = (orderId: string, token: string) => authed(request(httpServer).patch(`/pos/v1/orders/${orderId}/status`), token).send({ status: 'sent' })

  it('stores special instructions on the line and shows them on the kitchen ticket, with names not ids (CU-12, SE-22)', async () => {
    const { outletId, tableId, waiter, itemId } = await setUp()
    const order = await openTable(outletId, tableId, waiter.token)
    expect(order.ownerName).toBe('Asha')

    const added = await addLine(order.id, waiter.token, { itemId, note: '  less spicy  ' })
    expect(added.status).toBe(201)
    const line = (added.body as OrderBody).lines[0]
    expect(line).toMatchObject({ note: 'less spicy', addedByStaffName: 'Asha', sentToKitchen: false })

    expect((await send(order.id, waiter.token)).status).toBe(200)
    const queue = (await authed(request(httpServer).get(`/kitchen/v1/outlets/${outletId}/stations/unrouted/queue`), waiter.token)).body as { lines: { note: string | null }[] }[]
    expect(queue[0]?.lines[0]?.note).toBe('less spicy')

    expect((await addLine(order.id, waiter.token, { itemId, note: 'x'.repeat(201) })).status).toBe(400)
    const map = (await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/table-map`), waiter.token)).body as TableMapBody[]
    expect(map.find((t) => t.tableId === tableId)?.ownerName).toBe('Asha')
  })

  it('keeps an item added after the first send on the till until Send to kitchen, and lets it be removed meanwhile (CU-15)', async () => {
    const { outletId, tableId, waiter, itemId } = await setUp()
    const order = await openTable(outletId, tableId, waiter.token)
    await addLine(order.id, waiter.token, { itemId })
    await send(order.id, waiter.token)

    const wrongTap = (await addLine(order.id, waiter.token, { itemId, quantity: 3 })).body as OrderBody
    const added = wrongTap.lines.find((l) => l.quantity === 3) as LineBody
    expect(added.sentToKitchen).toBe(false)
    expect(await prisma.ticketLine.count({ where: { orderLineId: added.id } })).toBe(0)

    expect((await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/lines/${added.id}`), waiter.token).send({ quantity: 2 })).status).toBe(200)
    const removed = await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${added.id}`), waiter.token).send()
    expect(removed.status).toBe(200)
    expect((removed.body as OrderBody).lines).toHaveLength(1)

    // Nothing waiting: a second send is still the old invalid move.
    expect((await send(order.id, waiter.token)).status).toBe(409)

    const again = (await addLine(order.id, waiter.token, { itemId, quantity: 2 })).body as OrderBody
    const waiting = again.lines.find((l) => l.quantity === 2) as LineBody
    const fired = await send(order.id, waiter.token)
    expect(fired.status).toBe(200)
    expect((fired.body as OrderBody).lines.every((l) => l.sentToKitchen)).toBe(true)
    expect(await prisma.ticketLine.findFirst({ where: { orderLineId: waiting.id } })).toMatchObject({ addOnBatch: 1 })
  })

  it('voids a sent line only with a manager PIN; it leaves the order and bill and is struck on the ticket (CU-15)', async () => {
    const { tenantId, outletId, tableId, waiter, itemId } = await setUp()
    await createStaff(prisma, tenantId, outletId, 'Meera', { role: 'Manager', pin: '4321' })
    const order = await openTable(outletId, tableId, waiter.token)
    await addLine(order.id, waiter.token, { itemId })
    const sent = (await addLine(order.id, waiter.token, { itemId, quantity: 2 })).body as OrderBody
    const target = sent.lines.find((l) => l.quantity === 2) as LineBody
    await send(order.id, waiter.token)
    const bill = (await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/bill`), waiter.token).send()).body as BillBody
    expect(bill.subtotalMinor).toBe(30000)

    const removed = await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${target.id}`), waiter.token).send()
    expect(removed.status).toBe(409)
    expect((removed.body as ErrorBody).error.code).toBe('line_sent')

    const voidUrl = `/pos/v1/orders/${order.id}/lines/${target.id}/void`
    expect((await authed(request(httpServer).post(voidUrl), waiter.token).send({ reason: 'Wrong tap' })).status).toBe(400)
    expect((await authed(request(httpServer).post(voidUrl), waiter.token).send({ managerPin: '0000', reason: 'Wrong tap' })).status).toBe(401)

    const voided = await authed(request(httpServer).post(voidUrl), waiter.token).send({ managerPin: '4321', reason: 'Wrong tap' })
    expect(voided.status).toBe(200)
    expect((voided.body as OrderBody).lines.map((l) => l.id)).not.toContain(target.id)
    expect((await prisma.ticketLine.findFirstOrThrow({ where: { orderLineId: target.id } })).voided).toBe(true)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'void_after_fire', approverName: 'Meera' } })).toBe(1)

    const refreshed = (await authed(request(httpServer).get(`/pos/v1/bills/${bill.id}`), waiter.token)).body as BillBody
    expect(refreshed.subtotalMinor).toBe(10000)
    const invoice = (await authed(request(httpServer).get(`/pos/v1/bills/${bill.id}/invoice`), waiter.token)).body as { lines: unknown[] }
    expect(invoice.lines).toHaveLength(1)

    // Voiding twice is refused.
    expect((await authed(request(httpServer).post(voidUrl), waiter.token).send({ managerPin: '4321', reason: 'again' })).status).toBe(404)
  })

  it('discards an empty order - table back to empty, counter order and its bill gone - but never one with items (PE-16, CU-27)', async () => {
    const { tenantId, outletId, tableId, waiter, itemId } = await setUp()
    const tableOrder = await openTable(outletId, tableId, waiter.token)
    const other = await createStaff(prisma, tenantId, outletId, 'Ravi')
    expect((await authed(request(httpServer).delete(`/pos/v1/orders/${tableOrder.id}`), other.token).send()).status).toBe(403)

    expect((await authed(request(httpServer).delete(`/pos/v1/orders/${tableOrder.id}`), waiter.token).send()).status).toBe(204)
    const map = (await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/table-map`), waiter.token)).body as TableMapBody[]
    expect(map.find((t) => t.tableId === tableId)?.status).toBe('empty')

    const counter = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/counter-orders`), waiter.token).send()).body as OrderBody
    await authed(request(httpServer).post(`/pos/v1/orders/${counter.id}/bill`), waiter.token).send()
    expect((await authed(request(httpServer).delete(`/pos/v1/orders/${counter.id}`), waiter.token).send()).status).toBe(204)
    expect(await prisma.order.count({ where: { id: counter.id } })).toBe(0)
    expect(await prisma.bill.count({ where: { orderId: counter.id } })).toBe(0)
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'order.discarded' } })).toBe(2)

    const busy = await openTable(outletId, tableId, waiter.token)
    await addLine(busy.id, waiter.token, { itemId })
    const refused = await authed(request(httpServer).delete(`/pos/v1/orders/${busy.id}`), waiter.token).send()
    expect(refused.status).toBe(409)
    expect((refused.body as ErrorBody).error.code).toBe('order_not_empty')
  })

  it('flags a table whose QR guest session is still open, until staff reset it (CU-26)', async () => {
    const { tenantId, outletId, tableId, waiter } = await setUp()
    await prisma.tableSession.create({
      data: { tenantId, outletId, tableId, sessionPin: '1234', startedByGuestName: 'Guest', startedByGuestPhone: '+91 90000 00001', expiresAt: new Date(Date.now() + 3_600_000) },
    })
    const mapOf = async () => (await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/table-map`), waiter.token)).body as TableMapBody[]
    expect((await mapOf()).find((t) => t.tableId === tableId)).toMatchObject({ status: 'empty', guestSessionOpen: true })

    expect((await authed(request(httpServer).post(`/pos/v1/tables/${tableId}/close-session`), waiter.token).send()).status).toBe(200)
    expect((await mapOf()).find((t) => t.tableId === tableId)?.guestSessionOpen).toBe(false)
  })

  it('fires a never-sent counter order to the kitchen when its bill is finalised from Open orders (CU-17)', async () => {
    const { outletId, waiter, itemId } = await setUp()
    const counter = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/counter-orders`), waiter.token).send()).body as OrderBody
    await addLine(counter.id, waiter.token, { itemId, note: 'no onion' })
    const bill = (await authed(request(httpServer).post(`/pos/v1/orders/${counter.id}/bill`), waiter.token).send()).body as BillBody

    const finalized = await authed(request(httpServer).post(`/pos/v1/bills/${bill.id}/finalize`), waiter.token).send({
      tenders: [{ method: 'external', amountMinor: bill.totalMinor, reference: 'CARD-1' }],
    })
    expect(finalized.status).toBe(200)
    const tickets = await prisma.ticket.findMany({ where: { orderId: counter.id }, include: { lines: true } })
    expect(tickets).toHaveLength(1)
    expect(tickets[0]?.lines).toHaveLength(1)
  })
})
