// CAP-11 success criteria, end to end (SPEC-pos-cashier-waiter, story 11):
//  - the attendance list reflects real story 1 ClockEvent state: a staff
//    member who clocked in and hasn't clocked out shows up; one who clocked
//    out doesn't; a second same-day clock-in never duplicates the entry
//  - the mocked printer/connectivity status is present and clearly marked
//    as a placeholder, never dressed up as a real hardware check
//  - scoping is by outlet and tenant, same discipline as every other realm
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signPosToken, uuidv7 } from '../src/platform'

interface AttendanceBody {
  outletId: string
  asOf: string
  staff: { staffId: string; name: string; clockedInAt: string }[]
  printerStatus: { status: string; mocked: boolean }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
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
  await prisma.order.deleteMany()
  await prisma.clockEvent.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
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

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar', timezone = 'Asia/Kolkata'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone },
  })
  return outlet.id
}

async function createStaff(prisma: PrismaClient, tenantId: string, outletId: string, name: string): Promise<{ id: string; token: string }> {
  const role = await prisma.role.create({ data: { tenantId, name: `Waiter-${uuidv7()}`, isSystem: false } })
  const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name } })
  const token = signPosToken({ id: staff.id, tenantId, outletId, name })
  return { id: staff.id, token }
}

async function clockEvent(
  prisma: PrismaClient,
  tenantId: string,
  staffId: string,
  outletId: string,
  type: 'clock_in' | 'clock_out',
  occurredAt: Date,
): Promise<void> {
  await prisma.clockEvent.create({ data: { tenantId, staffId, outletId, type, occurredAt } })
}

describe('/pos/v1/outlets/:outletId/attendance (e2e)', () => {
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

  it('lists a staff member who clocked in and has not clocked out today', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const asha = await createStaff(prisma, tenantId, outletId, 'Asha')
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_in', new Date())

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/attendance`), asha.token)
    expect(res.status).toBe(200)
    const body = res.body as AttendanceBody
    expect(body.outletId).toBe(outletId)
    expect(body.staff).toEqual([{ staffId: asha.id, name: 'Asha', clockedInAt: expect.any(String) as string }])
  })

  it('excludes a staff member who has clocked out', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const asha = await createStaff(prisma, tenantId, outletId, 'Asha')
    const now = new Date()
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_in', new Date(now.getTime() - 60_000))
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_out', now)

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/attendance`), asha.token)
    expect(res.status).toBe(200)
    expect((res.body as AttendanceBody).staff).toEqual([])
  })

  it('does not duplicate a staff member with two clock-ins on the same day', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const asha = await createStaff(prisma, tenantId, outletId, 'Asha')
    const now = new Date()
    // Clock in, clock out, clock back in - still the same local day.
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_in', new Date(now.getTime() - 3 * 60_000))
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_out', new Date(now.getTime() - 2 * 60_000))
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_in', new Date(now.getTime() - 60_000))

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/attendance`), asha.token)
    expect(res.status).toBe(200)
    const body = res.body as AttendanceBody
    expect(body.staff).toHaveLength(1)
    expect(body.staff[0]?.staffId).toBe(asha.id)
  })

  it('excludes a stale open clock-in from an earlier local day', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const asha = await createStaff(prisma, tenantId, outletId, 'Asha')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_in', twoDaysAgo)

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/attendance`), asha.token)
    expect(res.status).toBe(200)
    expect((res.body as AttendanceBody).staff).toEqual([])
  })

  it('lists multiple currently clocked-in staff, sorted by name', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const vikram = await createStaff(prisma, tenantId, outletId, 'Vikram')
    const asha = await createStaff(prisma, tenantId, outletId, 'Asha')
    await clockEvent(prisma, tenantId, vikram.id, outletId, 'clock_in', new Date())
    await clockEvent(prisma, tenantId, asha.id, outletId, 'clock_in', new Date())

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/attendance`), asha.token)
    expect(res.status).toBe(200)
    const body = res.body as AttendanceBody
    expect(body.staff.map((s) => s.name)).toEqual(['Asha', 'Vikram'])
  })

  it('never lists a staff member clocked in at a different outlet', async () => {
    const tenantId = await createTenant(prisma)
    const outletA = await createOutlet(prisma, tenantId, 'Indiranagar')
    const outletB = await createOutlet(prisma, tenantId, 'Koramangala')
    const asha = await createStaff(prisma, tenantId, outletA, 'Asha')
    await clockEvent(prisma, tenantId, asha.id, outletA, 'clock_in', new Date())

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletB}/attendance`), asha.token)
    expect(res.status).toBe(200)
    expect((res.body as AttendanceBody).staff).toEqual([])
  })

  it('always returns the mocked printer status, clearly marked as a placeholder', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const asha = await createStaff(prisma, tenantId, outletId, 'Asha')

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${outletId}/attendance`), asha.token)
    expect(res.status).toBe(200)
    expect((res.body as AttendanceBody).printerStatus).toEqual({ status: 'connected', mocked: true })
  })

  it('rejects a request with no pos session', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const res = await request(httpServer).get(`/pos/v1/outlets/${outletId}/attendance`)
    expect(res.status).toBe(401)
  })

  it('never returns another tenant\'s outlet', async () => {
    const tenantId = await createTenant(prisma)
    const outletId = await createOutlet(prisma, tenantId)
    const asha = await createStaff(prisma, tenantId, outletId, 'Asha')

    const otherTenantId = await createTenant(prisma, 'Curry Leaf Kitchens')
    const otherOutletId = await createOutlet(prisma, otherTenantId, 'Koramangala')

    const res = await authed(request(httpServer).get(`/pos/v1/outlets/${otherOutletId}/attendance`), asha.token)
    expect(res.status).toBe(404)
  })
})
