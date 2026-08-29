// pos/CAP-5 success criteria, end to end (SPEC-pos-cashier-waiter, story 6):
//  - the outlet-wide list includes every open/sent order, table-tied or
//    counter (tableId null) alike - not just the ones the table map shows
//  - a closed order never appears in the list
//  - taking over another staff member's order uses story 3's real transfer
//    endpoint (reused, not reimplemented) - a read of the list afterwards
//    shows the new owner
//  - every read is scoped to the signed-in tenant (cross-tenant isolation)
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface OrderBody {
  id: string
  tenantId: string
  outletId: string
  tableId: string | null
  ownerId: string
  status: 'open' | 'sent' | 'closed'
  createdAt: string
  updatedAt: string
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

async function createStaff(prisma: PrismaClient, tenantId: string, name: string, outletId?: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const resolvedOutletId = outletId ?? (await prisma.outlet.findMany({ where: { tenantId } }))[0]?.id ?? uuidv7()
  const token = signPosToken({ id: staff.id, tenantId, outletId: resolvedOutletId, name })
  return { id: staff.id, token }
}

describe('/pos/v1 outlet-wide open and held orders (e2e)', () => {
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

  it('lists every open/sent order outlet-wide, table-tied and counter alike', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const waiter = await createStaff(prisma, tenantId, 'Asha', outletId)

    const tableOrder = (
      await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), waiter.token).send()
    ).body as OrderBody

    // Counter order: no table (CAP-6 hasn't built the QSR flow yet, but the
    // Order schema already allows tableId null - the list must not assume
    // every order has a table).
    const counterOrder = await prisma.order.create({
      data: { tenantId, outletId, tableId: null, ownerId: waiter.id, status: 'open' },
    })

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`), waiter.token)
    expect(res.status).toBe(200)
    const orders = res.body as OrderBody[]
    expect(orders.map((o) => o.id).sort()).toEqual([tableOrder.id, counterOrder.id].sort())
    expect(orders.find((o) => o.id === counterOrder.id)?.tableId).toBeNull()
  })

  it('excludes closed orders', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const waiter = await createStaff(prisma, tenantId, 'Asha', outletId)

    const order = (
      await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), waiter.token).send()
    ).body as OrderBody
    await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
    await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'closed' })

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`), waiter.token)
    expect(res.status).toBe(200)
    expect(res.body as OrderBody[]).toEqual([])
  })

  it('reflects the new owner after a take-over via the real transfer endpoint', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const original = await createStaff(prisma, tenantId, 'Asha', outletId)
    const incoming = await createStaff(prisma, tenantId, 'Vikram', outletId)

    const order = (
      await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), original.token).send()
    ).body as OrderBody

    const beforeList = (await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`), incoming.token)).body as OrderBody[]
    expect(beforeList[0].ownerId).toBe(original.id)

    await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/transfer`), incoming.token).send({
      newOwnerStaffId: incoming.id,
    })

    const afterList = (await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`), incoming.token)).body as OrderBody[]
    expect(afterList).toHaveLength(1)
    expect(afterList[0].id).toBe(order.id)
    expect(afterList[0].ownerId).toBe(incoming.id)
  })

  it('lets any staff member view the list, not only order owners', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const owner = await createStaff(prisma, tenantId, 'Asha', outletId)
    const viewer = await createStaff(prisma, tenantId, 'Vikram', outletId)
    await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`), viewer.token)
    expect(res.status).toBe(200)
    expect((res.body as OrderBody[])).toHaveLength(1)
  })

  it('rejects a request with no pos session', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const res = await request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`)
    expect(res.status).toBe(401)
  })

  it('never returns another tenant\'s orders, and 404s for another tenant\'s outlet id', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const tableId = await createTable(prisma, tenantId, outletId)
    const waiter = await createStaff(prisma, tenantId, 'Asha', outletId)
    await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), waiter.token).send()

    const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
    const otherOutletId = await createOutlet(prisma, otherTenantId, 'Koramangala')

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${otherOutletId}/orders`), waiter.token)
    expect(res.status).toBe(404)
  })
})
