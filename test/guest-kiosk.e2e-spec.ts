// Issue #138: a kiosk tab orders through the guest realm without a table -
// the enrolled kiosk device is the session's identity, the outlet's `kiosk`
// capability is the gate, and the placed order is a token-numbered counter
// order that the kitchen and the POS see like any other.
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
interface KioskStartBody {
  token: string
  session: { sessionId: string; table: null | { id: string }; guests: { name: string }[] }
}
interface PlacedOrderBody {
  orderId: string
  tableId: string | null
  source: string
  tokenNumber: number | null
  lines: unknown[]
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

async function createTenant(prisma: PrismaClient, name = 'Kiosk Test Co'): Promise<string> {
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
  return tenantId
}

async function createOutlet(prisma: PrismaClient, tenantId: string): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Kiosk Brand' } })
  const outlet = await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'Counter', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
  return outlet.id
}

async function createDevice(prisma: PrismaClient, tenantId: string, outletId: string, type: 'kiosk' | 'pos', status: 'active' | 'revoked' = 'active'): Promise<string> {
  const device = await prisma.device.create({
    data: { tenantId, outletId, label: `${type.toUpperCase()}-1`, type, status, hardwareKeyFingerprint: `fp-${uuidv7()}`, enrolledAt: new Date(), revokedAt: status === 'revoked' ? new Date() : null },
  })
  return device.id
}

async function setCapability(prisma: PrismaClient, tenantId: string, outletId: string, key: string, enabled: boolean): Promise<void> {
  await prisma.outletCapability.upsert({ where: { outletId_key: { outletId, key } }, create: { tenantId, outletId, key, enabled }, update: { enabled } })
}

async function createItemWithPrice(prisma: PrismaClient, tenantId: string, priceMinor: number): Promise<string> {
  const category = await prisma.menuCategory.create({ data: { tenantId, name: 'Mains', sortOrder: 0 } })
  const item = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: `Item-${uuidv7()}`, shortName: 'Itm', available: true } })
  await prisma.itemPrice.create({ data: { tenantId, itemId: item.id, priceMinor: BigInt(priceMinor), currency: 'INR' } })
  return item.id
}

async function createStaffToken(prisma: PrismaClient, tenantId: string, outletId: string): Promise<string> {
  const role = await prisma.role.create({ data: { tenantId, name: `Cashier-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Cashier' } })
  return signPosToken({ id: staff.id, tenantId, outletId, name: 'Cashier' })
}

describe('/guest/v1/kiosk kiosk ordering (e2e)', () => {
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

  it('starts a table-less session for an active kiosk, places a token-numbered kiosk order, and the POS sees it', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    await setCapability(prisma, tenantId, outletId, 'kiosk', true)
    const deviceId = await createDevice(prisma, tenantId, outletId, 'kiosk')
    const item = await createItemWithPrice(prisma, tenantId, 12000)

    const startRes = await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId, deviceId })
    expect(startRes.status).toBe(201)
    const { token, session } = startRes.body as KioskStartBody
    expect(session.table).toBeNull()
    expect(session.guests).toEqual([expect.objectContaining({ name: 'KIOSK-1' })])

    const current = await authed(request(httpServer).get('/guest/v1/session'), token)
    expect(current.status).toBe(200)
    expect((current.body as KioskStartBody['session']).table).toBeNull()

    await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: item, quantity: 2 }).expect(201)
    const placeRes = await authed(request(httpServer).post('/guest/v1/orders'), token).send({})
    expect(placeRes.status).toBe(201)
    const placed = placeRes.body as PlacedOrderBody
    expect(placed).toMatchObject({ tableId: null, source: 'kiosk', tokenNumber: 1 })
    expect(placed.lines).toHaveLength(1)

    // A second kiosk order at the outlet takes the next token, gap-free.
    const second = (await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId, deviceId })).body as KioskStartBody
    await authed(request(httpServer).post('/guest/v1/cart/lines'), second.token).send({ itemId: item, quantity: 1 }).expect(201)
    const secondPlaced = (await authed(request(httpServer).post('/guest/v1/orders'), second.token).send({})).body as PlacedOrderBody
    expect(secondPlaced.tokenNumber).toBe(2)

    // The status stepper carries the token; the session lists only its own order.
    const status = await authed(request(httpServer).get('/guest/v1/session/orders'), token)
    expect(status.status).toBe(200)
    expect((status.body as { orders: PlacedOrderBody[] }).orders).toEqual([expect.objectContaining({ orderId: placed.orderId, tokenNumber: 1, tableId: null })])

    // Kitchen fired it and the POS open-orders list has it, like a counter order.
    expect(await prisma.ticket.count({ where: { orderId: placed.orderId } })).toBeGreaterThan(0)
    const staffToken = await createStaffToken(prisma, tenantId, outletId)
    const list = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/orders`), staffToken)
    expect(list.status).toBe(200)
    const found = (list.body as Array<{ id: string; source: string; tokenNumber: number | null; ownerId: string | null }>).find((o) => o.id === placed.orderId)
    expect(found).toMatchObject({ source: 'kiosk', tokenNumber: 1, ownerId: null })
  })

  it('pays a kiosk order by card at the kiosk and serves the receipt invoice (issue #144)', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    await setCapability(prisma, tenantId, outletId, 'kiosk', true)
    const deviceId = await createDevice(prisma, tenantId, outletId, 'kiosk')
    const item = await createItemWithPrice(prisma, tenantId, 12000)

    const { token } = (await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId, deviceId })).body as KioskStartBody
    await authed(request(httpServer).post('/guest/v1/cart/lines'), token).send({ itemId: item, quantity: 1 }).expect(201)
    const placed = (await authed(request(httpServer).post('/guest/v1/orders'), token).send({})).body as PlacedOrderBody

    const billRes = await authed(request(httpServer).post(`/guest/v1/orders/${placed.orderId}/bill`), token)
    expect(billRes.status).toBe(201)
    const bill = billRes.body as { id: string; totalMinor: number }

    const paid = await authed(request(httpServer).post(`/guest/v1/bills/${bill.id}/pay-all`), token).send({ simulatedOutcome: 'success' })
    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ status: 'finalized' })

    // The session is settled now, but the kiosk can still fetch the invoice to print.
    const invoice = await authed(request(httpServer).get(`/guest/v1/bills/${bill.id}/invoice`), token)
    expect(invoice.status).toBe(200)
    expect((invoice.body as { tenders: Array<{ method: string; amountMinor: number }> }).tenders).toEqual([
      expect.objectContaining({ method: 'card_terminal', amountMinor: bill.totalMinor }),
    ])
    // The card money went through a confirmed payment intent, like the POS card terminal's.
    expect(await prisma.paymentIntent.count({ where: { billId: bill.id, rail: 'card_terminal', status: 'succeeded' } })).toBe(1)
  })

  it('refuses a revoked, non-kiosk, other-outlet or unknown device as 404, and a disabled capability as 403', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const otherOutletId = await createOutlet(prisma, tenantId)
    await setCapability(prisma, tenantId, outletId, 'kiosk', true)
    const revoked = await createDevice(prisma, tenantId, outletId, 'kiosk', 'revoked')
    const pos = await createDevice(prisma, tenantId, outletId, 'pos')
    const elsewhere = await createDevice(prisma, tenantId, otherOutletId, 'kiosk')

    for (const deviceId of [revoked, pos, elsewhere, uuidv7()]) {
      const res = await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId, deviceId })
      expect(res.status).toBe(404)
      expect((res.body as ErrorBody).error.code).toBe('not_found')
    }
    await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId: uuidv7(), deviceId: pos }).expect(404)
    await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId, deviceId: 'nope' }).expect(400)

    // The capability gate is server-side: an active kiosk at an outlet with
    // kiosk mode off (or no row at all) never gets a session.
    await setCapability(prisma, tenantId, outletId, 'kiosk', false)
    const kiosk = await createDevice(prisma, tenantId, outletId, 'kiosk')
    const off = await request(httpServer).post('/guest/v1/kiosk/sessions').send({ outletId, deviceId: kiosk })
    expect(off.status).toBe(403)
    expect((off.body as ErrorBody).error.code).toBe('kiosk_disabled')
  })
})
