// restiq-backend#209 (SE-26): staff restricted to some outlets (StaffUser.outletIds, #197) were only held to
// them at sign-in; every order/bill/shift/kitchen endpoint trusted the outlet in the URL. PosAuthGuard now
// checks every outlet a request reaches - named in the URL/body/query or owning the resource it names.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

describe('outlet-restricted staff on every POS/kitchen request (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let server: Parameters<typeof request>[0]
  const tenantId = uuidv7()
  let outletA: string
  let outletB: string
  let restricted: string
  let everywhere: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    server = app.getHttpServer() as Parameters<typeof request>[0]

    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Scope Co', registeredAddress: '1 Test Street', contactName: 'Test', contactEmail: 'scope@test.example', contactPhone: '+91 90000 00000', country: 'IN', status: 'active', plan: 'standard', billingPeriod: 'monthly' },
    })
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Scope Brand' } })
    outletA = (await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'A', address: 'A1', type: 'qsr', timezone: 'Asia/Kolkata' } })).id
    outletB = (await prisma.outlet.create({ data: { tenantId, brandId: brand.id, name: 'B', address: 'B1', type: 'qsr', timezone: 'Asia/Kolkata' } })).id
    const role = await prisma.role.create({ data: { tenantId, name: 'Manager', isSystem: true, isManager: true } })
    const asha = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Asha', outletIds: [outletA] } })
    const ravi = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: 'Ravi' } })
    restricted = signPosToken({ id: asha.id, tenantId, outletId: outletA, name: 'Asha', sessionVersion: 0 })
    everywhere = signPosToken({ id: ravi.id, tenantId, outletId: outletB, name: 'Ravi', sessionVersion: 0 })
  })

  afterAll(async () => {
    const where = { tenantId }
    await prisma.ticket.deleteMany({ where })
    await prisma.bill.deleteMany({ where })
    await prisma.billNumberCounter.deleteMany({ where })
    await prisma.tokenNumberCounter.deleteMany({ where })
    await prisma.order.deleteMany({ where })
    await prisma.clockEvent.deleteMany({ where })
    await prisma.staffUser.deleteMany({ where })
    await prisma.role.deleteMany({ where })
    await prisma.outlet.deleteMany({ where })
    await prisma.brand.deleteMany({ where })
    await prisma.auditEvent.deleteMany({ where })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.tenantRegistryEntry.deleteMany({ where })
    await app.close()
    await prisma.$disconnect()
  })

  const as = (token: string) => ({
    get: (path: string) => request(server).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => request(server).post(path).set('Authorization', `Bearer ${token}`).send(body),
  })

  it('refuses another outlet named in the URL, body or query - and still serves their own', async () => {
    const refused = [
      await as(restricted).get(`/pos/v1/outlets/${outletB}/orders`),
      await as(restricted).get(`/pos/v1/outlets/${outletB}/table-map`),
      await as(restricted).post(`/pos/v1/outlets/${outletB}/counter-orders`),
      await as(restricted).get(`/pos/v1/outlets/${outletB}/payments`),
      await as(restricted).get(`/pos/v1/outlets/${outletB}/attendance`),
      await as(restricted).get(`/kitchen/v1/outlets/${outletB}/expo`),
      await as(restricted).post('/pos/v1/shifts', { outletId: outletB, openingFloatMinor: 0 }),
      await as(restricted).get(`/pos/v1/shifts/current?outletId=${outletB}`),
    ]
    expect(refused.map((res) => res.status)).toEqual(refused.map(() => 403))
    expect((refused[0].body as { error: { code: string } }).error.code).toBe('outlet_mismatch')

    expect((await as(restricted).get(`/pos/v1/outlets/${outletA}/orders`)).status).toBe(200)
  })

  it("refuses another outlet's order, bill and kitchen ticket by id", async () => {
    const order = await as(everywhere).post(`/pos/v1/outlets/${outletB}/counter-orders`)
    expect(order.status).toBe(201)
    const { id: orderId } = order.body as { id: string }
    expect((await as(restricted).get(`/pos/v1/orders/${orderId}`)).status).toBe(403)
    expect((await as(restricted).post(`/pos/v1/orders/${orderId}/bill`)).status).toBe(403)
    expect((await as(everywhere).get(`/pos/v1/orders/${orderId}`)).status).toBe(200)

    const bill = await prisma.bill.findFirst({ where: { orderId } })
    if (bill) expect((await as(restricted).get(`/pos/v1/bills/${bill.id}`)).status).toBe(403)

    const ticket = await prisma.ticket.create({ data: { tenantId, outletId: outletB, orderId } })
    expect((await as(restricted).post(`/kitchen/v1/tickets/${ticket.id}/bump`)).status).toBe(403)
  })
})
