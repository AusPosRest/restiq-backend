// pos/CAP-2 success criteria, end to end (SPEC-pos-cashier-waiter, story 3):
//  - the table map reflects open/empty correctly, reusing the existing
//    Floor/DiningTable models rather than a second table model
//  - a second staff member can view an occupied table's order, but a
//    mutation attempt from anyone but the owner is rejected naming the
//    current owner - never a silent edit
//  - the explicit transfer action reassigns ownership; the new owner can
//    then mutate, and the old owner no longer can
//  - every read/write is scoped to the signed-in tenant (cross-tenant
//    isolation, NFR-8), same discipline as every other realm
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface ErrorBody {
  error: { code: string; message: string; ownerId?: string }
}
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
interface TableMapEntryBody {
  tableId: string
  floorId: string
  label: string
  seatCapacity: number
  status: 'occupied' | 'empty'
  orderId: string | null
  ownerId: string | null
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

async function createStaff(prisma: PrismaClient, tenantId: string, name: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const outlets = await prisma.outlet.findMany({ where: { tenantId } })
  const token = signPosToken({ id: staff.id, tenantId, outletId: outlets[0]?.id ?? uuidv7(), name })
  return { id: staff.id, token }
}

describe('/pos/v1 table map and order ownership (e2e)', () => {
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

  describe('table map', () => {
    it('shows an empty table before any order is opened', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, 'Asha')

      const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/table-map`), waiter.token)
      expect(res.status).toBe(200)
      const map = res.body as TableMapEntryBody[]
      expect(map).toEqual([{ tableId, floorId: expect.any(String) as string, label: 'T1', seatCapacity: 4, status: 'empty', orderId: null, ownerId: null }])
    })

    it('shows a table as occupied once its order is opened, and empty again once the order closes', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, 'Asha')

      const openRes = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), waiter.token)
      expect(openRes.status).toBe(200)
      const order = openRes.body as OrderBody
      expect(order).toMatchObject({ tenantId, outletId, tableId, ownerId: waiter.id, status: 'open' })

      const occupiedMap = (await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/table-map`), waiter.token)).body as TableMapEntryBody[]
      expect(occupiedMap[0]).toMatchObject({ tableId, status: 'occupied', orderId: order.id, ownerId: waiter.id })

      await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
      const closeRes = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'closed' })
      expect(closeRes.status).toBe(200)

      const emptyAgainMap = (await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/table-map`), waiter.token)).body as TableMapEntryBody[]
      expect(emptyAgainMap[0]).toMatchObject({ tableId, status: 'empty', orderId: null, ownerId: null })
    })

    it('rejects an invalid forward transition (open straight to closed)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, 'Asha')
      const order = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), waiter.token).send()).body as OrderBody

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'closed' })
      expect(res.status).toBe(409)
      expect((res.body as ErrorBody).error.code).toBe('invalid_transition')
    })

    it('claiming an already-occupied table returns the existing order, never a second one', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, 'Asha')
      const second = await createStaff(prisma, tenantId, 'Vikram')

      const first = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), waiter.token).send()).body as OrderBody
      const claimRes = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), second.token).send()
      expect(claimRes.status).toBe(200)
      const claimed = claimRes.body as OrderBody
      // Viewing an occupied table's order is not a takeover - ownership is untouched.
      expect(claimed).toEqual(first)

      const orders = await prisma.order.findMany({ where: { tableId } })
      expect(orders).toHaveLength(1)
    })
  })

  describe('ownership and mutation', () => {
    it('lets any staff member view an occupied table\'s order', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, 'Asha')
      const viewer = await createStaff(prisma, tenantId, 'Vikram')
      const order = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()).body as OrderBody

      const res = await authed(request(httpServer).get(`/pos/v1/orders/${order.id}`), viewer.token)
      expect(res.status).toBe(200)
      expect((res.body as OrderBody).id).toBe(order.id)
    })

    it('rejects a non-owner\'s mutation, naming the current owner', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, 'Asha')
      const other = await createStaff(prisma, tenantId, 'Vikram')
      const order = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()).body as OrderBody

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), other.token).send({ status: 'sent' })
      expect(res.status).toBe(403)
      const body = res.body as ErrorBody
      expect(body.error.code).toBe('not_owner')
      expect(body.error.ownerId).toBe(owner.id)
      expect(body.error.message).toContain('Asha')
    })

    it('transfers ownership so the new owner can mutate and the old owner no longer can', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const original = await createStaff(prisma, tenantId, 'Asha')
      const incoming = await createStaff(prisma, tenantId, 'Vikram')
      const order = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), original.token).send()).body as OrderBody

      // Transfer is callable by anyone (not CAP-8-gated) - the incoming staff
      // member calls it themselves here, same as a manager or the outgoing
      // owner could.
      const transferRes = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/transfer`), incoming.token).send({
        newOwnerStaffId: incoming.id,
      })
      expect(transferRes.status).toBe(201)
      expect((transferRes.body as OrderBody).ownerId).toBe(incoming.id)

      const newOwnerMutates = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), incoming.token).send({ status: 'sent' })
      expect(newOwnerMutates.status).toBe(200)

      const oldOwnerBlocked = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), original.token).send({ status: 'closed' })
      expect(oldOwnerBlocked.status).toBe(403)
      expect((oldOwnerBlocked.body as ErrorBody).error.ownerId).toBe(incoming.id)

      const auditRow = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'order.ownership_transferred' } })
      expect(auditRow).not.toBeNull()
    })

    it('rejects transferring to a staff member from another tenant', async () => {
      const tenantId = await createTenant(prisma)
      const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, 'Asha')
      const outsider = await createStaff(prisma, otherTenantId, 'Rahul')
      const order = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()).body as OrderBody

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/transfer`), owner.token).send({ newOwnerStaffId: outsider.id })
      expect(res.status).toBe(400)
    })
  })

  describe('tenant isolation and auth', () => {
    it('rejects a request with no pos session', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await request(httpServer).get(`/pos/v1/outlets/${outletId}/table-map`)
      expect(res.status).toBe(401)
    })

    it('never returns another tenant\'s table map', async () => {
      const tenantId = await createTenant(prisma)
      const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
      const otherOutletId = await createOutlet(prisma, otherTenantId, 'Koramangala')
      const waiter = await createStaff(prisma, tenantId, 'Asha')

      const res = await authed(request(httpServer).get(`/pos/v1/outlets/${otherOutletId}/table-map`), waiter.token)
      expect(res.status).toBe(404)
    })

    it('never returns another tenant\'s order', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, 'Asha')
      const order = (await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), owner.token).send()).body as OrderBody

      const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
      const outsider = await createStaff(prisma, otherTenantId, 'Rahul')

      const res = await authed(request(httpServer).get(`/pos/v1/orders/${order.id}`), outsider.token)
      expect(res.status).toBe(404)
    })
  })
})
