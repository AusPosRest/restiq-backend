// pos/CAP-3 success criteria, end to end (SPEC-pos-cashier-waiter, story 4):
//  - a valid line can be added and appears on the order, built against the
//    real menu catalogue (item/variant/modifier-group/modifier rows from
//    tenant-admin/CAP-4)
//  - a line violating a modifier group's min/max is rejected 400 server-side,
//    even when a client skips its own validation entirely
//  - price is snapshotted at add-time: a later item_price change never
//    retroactively alters an already-added line
//  - only the order's owner may add/edit/remove its lines (pos/CAP-2's rule,
//    reused, not reimplemented)
//  - a line can be edited/removed only while the order is still "open";
//    adding a new line remains possible after the order is "sent" (AD-14:
//    Order is mutable pre-finalisation)
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
interface OrderLineModifierBody {
  id: string
  modifierId: string
  name: string
  priceMinor: number
}
interface OrderLineBody {
  id: string
  orderId: string
  itemId: string
  variantId: string | null
  quantity: number
  unitPriceMinor: number
  seatNumber: number | null
  addedByStaffId: string
  createdAt: string
  modifiers: OrderLineModifierBody[]
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
  lines: OrderLineBody[]
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
  await prisma.billShare.deleteMany()
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
  opts?: { withVariant?: boolean; modifierGroup?: { minSelections: number; maxSelections: number; modifiers: number[] } },
): Promise<{ itemId: string; variantId: string | null; modifierGroupId: string | null; modifierIds: string[] }> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm' } })

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

  return { itemId: item.id, variantId, modifierGroupId, modifierIds }
}

describe('/pos/v1 order lines (e2e)', () => {
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
    // Other spec files' own wipe() helpers delete menu_items without first
    // clearing order_lines (that FK didn't exist when they were written) -
    // leaving rows here after this file's last test would break whichever
    // spec file happens to run next, purely by file-execution order. Clean
    // up on the way out so this file is never the cause of that.
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

  async function openOrder(outletId: string, tableId: string, token: string): Promise<OrderBody> {
    const res = await authed(request(httpServer).post(`/pos/v1/outlets/${outletId}/tables/${tableId}/order`), token).send()
    return res.body as OrderBody
  }

  describe('adding a line', () => {
    it('adds a valid line and it appears on the order', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 2 })
      expect(res.status).toBe(201)
      const body = res.body as OrderBody
      expect(body.lines).toHaveLength(1)
      expect(body.lines[0]).toMatchObject({ itemId, quantity: 2, unitPriceMinor: 19000, addedByStaffId: waiter.id, modifiers: [] })

      const fetched = await authed(request(httpServer).get(`/pos/v1/orders/${order.id}`), waiter.token)
      expect((fetched.body as OrderBody).lines).toHaveLength(1)
    })

    it('resolves the variant-specific price when a variantId is given', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId, variantId } = await createItemWithPrice(prisma, tenantId, 25000, { withVariant: true })
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, variantId, quantity: 1 })
      expect(res.status).toBe(201)
      expect((res.body as OrderBody).lines[0]).toMatchObject({ variantId, unitPriceMinor: 25000 })
    })

    it('adds a line with a valid modifier selection, snapshotting each modifier price', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId, modifierIds } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 1, maxSelections: 1, modifiers: [0, 5000] },
      })
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({
        itemId,
        quantity: 1,
        modifierIds: [modifierIds[1]],
      })
      expect(res.status).toBe(201)
      const line = (res.body as OrderBody).lines[0]
      expect(line?.modifiers).toHaveLength(1)
      expect(line?.modifiers[0]).toMatchObject({ modifierId: modifierIds[1], priceMinor: 5000 })
    })

    it('rejects a line violating a modifier group\'s min/max, even if the client sent no selection at all', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 1, maxSelections: 1, modifiers: [0, 5000] },
      })
      const order = await openOrder(outletId, tableId, waiter.token)

      // A real client would block this in its own UI - this simulates one
      // that skipped that check entirely, proving the server enforces it too.
      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, modifierIds: [] })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('modifier_selection_invalid')
      expect(await prisma.orderLine.count({ where: { orderId: order.id } })).toBe(0)
    })

    it('rejects selecting more modifiers than a group\'s max allows', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId, modifierIds } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 0, maxSelections: 1, modifiers: [0, 5000] },
      })
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, modifierIds })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('modifier_selection_invalid')
    })

    it('rejects a modifier id that does not belong to the item', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, modifierIds: [uuidv7()] })
      expect(res.status).toBe(400)
    })

    it('rejects an item with no current price configured', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
      const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: 'No Price Item', shortName: 'NPI' } })
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId: item.id, quantity: 1 })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('no_price')
    })

    it('rejects an item that belongs to another tenant', async () => {
      const tenantId = await createTenant(prisma)
      const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId: foreignItemId } = await createItemWithPrice(prisma, otherTenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId: foreignItemId, quantity: 1 })
      expect(res.status).toBe(400)
    })

    it('still allows adding a line once the order has been sent (AD-14: mutable pre-finalisation)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      expect(res.status).toBe(201)
    })

    it('rejects adding a line to a closed order', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
      await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'closed' })

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      expect(res.status).toBe(409)
    })

    it('rejects a non-owner adding a line, naming the current owner', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
      const other = await createStaff(prisma, tenantId, outletId, 'Vikram')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, owner.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), other.token).send({ itemId, quantity: 1 })
      expect(res.status).toBe(403)
      expect((res.body as ErrorBody).error.code).toBe('not_owner')
      expect((res.body as ErrorBody).error.ownerId).toBe(owner.id)
    })
  })

  describe('price snapshotting', () => {
    it('does not retroactively change an existing line\'s price after the item price changes', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)

      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id

      // Price change lands after the line was added.
      await prisma.itemPrice.create({ data: { tenantId, itemId, priceMinor: 25000n, currency: 'INR', channel: 'dine_in' } })

      const fetched = await authed(request(httpServer).get(`/pos/v1/orders/${order.id}`), waiter.token)
      const line = (fetched.body as OrderBody).lines.find((l) => l.id === lineId)
      expect(line?.unitPriceMinor).toBe(19000)

      // The new price is what the NEXT line added gets, proving the old
      // line's value truly is a frozen snapshot and not a live read.
      const secondLine = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      expect((secondLine.body as OrderBody).lines.find((l) => l.id !== lineId)?.unitPriceMinor).toBe(25000)
    })
  })

  describe('updating a line', () => {
    it('changes quantity while the order is still open', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/lines/${lineId}`), waiter.token).send({ quantity: 4 })
      expect(res.status).toBe(200)
      expect((res.body as OrderBody).lines[0]).toMatchObject({ id: lineId, quantity: 4 })
    })

    it('re-validates modifier min/max when re-selecting modifiers', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId, modifierIds } = await createItemWithPrice(prisma, tenantId, 19000, {
        modifierGroup: { minSelections: 1, maxSelections: 1, modifiers: [0, 5000] },
      })
      const order = await openOrder(outletId, tableId, waiter.token)
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, modifierIds: [modifierIds[0]] })
      const lineId = (added.body as OrderBody).lines[0]?.id

      const badUpdate = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/lines/${lineId}`), waiter.token).send({ modifierIds: [] })
      expect(badUpdate.status).toBe(400)

      const goodUpdate = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/lines/${lineId}`), waiter.token).send({ modifierIds: [modifierIds[1]] })
      expect(goodUpdate.status).toBe(200)
      expect((goodUpdate.body as OrderBody).lines[0]?.modifiers).toEqual([expect.objectContaining({ modifierId: modifierIds[1], priceMinor: 5000 })])
    })

    it('rejects editing a line once the order has been sent', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      // Seated (pos/CAP-4, issue #58) so the status transition below succeeds
      // - this test is about the send-blocks-further-edits rule, not the
      // group-ordering gate itself.
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, seatNumber: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id
      const sent = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
      expect(sent.status).toBe(200)

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/lines/${lineId}`), waiter.token).send({ quantity: 9 })
      expect(res.status).toBe(409)
    })

    it('rejects a non-owner editing a line', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
      const other = await createStaff(prisma, tenantId, outletId, 'Vikram')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, owner.token)
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), owner.token).send({ itemId, quantity: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/lines/${lineId}`), other.token).send({ quantity: 2 })
      expect(res.status).toBe(403)
    })
  })

  describe('removing a line', () => {
    it('removes a line while the order is open', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id

      const res = await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${lineId}`), waiter.token)
      expect(res.status).toBe(200)
      expect((res.body as OrderBody).lines).toHaveLength(0)
      expect(await prisma.orderLine.count({ where: { id: lineId } })).toBe(0)
    })

    it('rejects removing a line once the order has been sent', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      // Seated (pos/CAP-4, issue #58) so the status transition below succeeds
      // - this test is about the send-blocks-removal rule, not the
      // group-ordering gate itself.
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, seatNumber: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id
      const sent = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
      expect(sent.status).toBe(200)

      const res = await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${lineId}`), waiter.token)
      expect(res.status).toBe(409)
      expect(await prisma.orderLine.count({ where: { id: lineId } })).toBe(1)
    })

    it('rejects a non-owner removing a line', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const owner = await createStaff(prisma, tenantId, outletId, 'Asha')
      const other = await createStaff(prisma, tenantId, outletId, 'Vikram')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, owner.token)
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), owner.token).send({ itemId, quantity: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id

      const res = await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${lineId}`), other.token)
      expect(res.status).toBe(403)
      expect(await prisma.orderLine.count({ where: { id: lineId } })).toBe(1)
    })

    it('404s removing a line id that does not belong to this order', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).delete(`/pos/v1/orders/${order.id}/lines/${uuidv7()}`), waiter.token)
      expect(res.status).toBe(404)
    })
  })

  // pos/CAP-4 group ordering (SPEC-pos-cashier-waiter, story 5, issue #58):
  // extends story 4's OrderLine with an application-enforced seat number -
  // every line must carry one before the order can move to "sent", but the
  // add/edit/remove paths themselves never require it (a table not using
  // group ordering just never sets seatNumber, and behaves exactly as before).
  describe('seat numbers (group ordering)', () => {
    it('adds a line with a seat number', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, seatNumber: 2 })
      expect(res.status).toBe(201)
      expect((res.body as OrderBody).lines[0]).toMatchObject({ seatNumber: 2 })
    })

    it('a line added without a seat number carries a null seatNumber (story 4 behaviour unchanged)', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)

      const res = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      expect(res.status).toBe(201)
      expect((res.body as OrderBody).lines[0]).toMatchObject({ seatNumber: null })
    })

    it('assigns a seat number on an existing line via PATCH', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      const added = await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      const lineId = (added.body as OrderBody).lines[0]?.id

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/lines/${lineId}`), waiter.token).send({ seatNumber: 3 })
      expect(res.status).toBe(200)
      expect((res.body as OrderBody).lines[0]).toMatchObject({ id: lineId, seatNumber: 3 })
    })

    it('sends an order to the kitchen once every line has a seat number', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, seatNumber: 1 })
      await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 2, seatNumber: 2 })

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
      expect(res.status).toBe(200)
      expect((res.body as OrderBody).status).toBe('sent')
    })

    it('rejects sending an order when any line has no seat number, with a clear message, and leaves the order open', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1, seatNumber: 1 })
      await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 }) // unseated

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
      expect(res.status).toBe(400)
      const body = res.body as ErrorBody
      expect(body.error.code).toBe('unseated_lines')
      expect(body.error.message).toMatch(/seat/i)

      const fetched = await authed(request(httpServer).get(`/pos/v1/orders/${order.id}`), waiter.token)
      expect((fetched.body as OrderBody).status).toBe('open')
    })

    it('still rejects an order with zero seated lines out of several unseated ones', async () => {
      const tenantId = await createTenant(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const tableId = await createTable(prisma, tenantId, outletId)
      const waiter = await createStaff(prisma, tenantId, outletId, 'Asha')
      const { itemId } = await createItemWithPrice(prisma, tenantId, 19000)
      const order = await openOrder(outletId, tableId, waiter.token)
      await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })
      await authed(request(httpServer).post(`/pos/v1/orders/${order.id}/lines`), waiter.token).send({ itemId, quantity: 1 })

      const res = await authed(request(httpServer).patch(`/pos/v1/orders/${order.id}/status`), waiter.token).send({ status: 'sent' })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('unseated_lines')
    })
  })
})
