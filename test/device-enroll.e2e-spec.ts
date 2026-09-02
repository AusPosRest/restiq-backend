// Issue #89: the public device realm. A browser page stands in for a real
// device and redeems its own one-time enrolment code with no operator
// session at all - same one-time-use/expiry semantics as the ops-realm
// enroll (test/device-fleet.e2e-spec.ts), reused via
// DevicesService.enrollWithActor rather than reimplemented.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signOpsToken, uuidv7 } from '../src/platform'

const EMAIL = 'device-enroll-operator@restiq.example'

interface DeviceView {
  id: string
  tenantId: string
  outletId: string | null
  label: string
  type: string
  role: string
  status: string
  enrolledAt: string
  revokedAt: string | null
}

async function wipe(prisma: PrismaClient): Promise<void> {
  await prisma.cartLineModifier.deleteMany()
  await prisma.cartLine.deleteMany()
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.ticketLine.deleteMany()
  await prisma.orderLine.deleteMany()
  await prisma.cashMovement.deleteMany()
  await prisma.shift.deleteMany()
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

describe('/device/v1/enroll (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let opsToken: string
  let tenantId: string
  let outletId: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: EMAIL } })
    const operator = await prisma.operatorUser.create({
      data: { email: EMAIL, passwordHash: await argon2.hash('irrelevant-here') },
    })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })

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
    tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Spice Route Hospitality',
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
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
    const outlet = await prisma.outlet.create({
      data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })
    outletId = outlet.id
  })

  async function generateCode(overrides?: Partial<{ tenantId: string; outletId: string; deviceType: string }>) {
    const res = await request(httpServer)
      .post('/ops/v1/devices/enrolment-codes')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({
        tenantId: overrides?.tenantId ?? tenantId,
        outletId: overrides?.outletId ?? outletId,
        deviceType: overrides?.deviceType ?? 'pos',
      })
    return res
  }

  function codeOf(res: request.Response): string {
    return (res.body as { code: string }).code
  }

  function deviceOf(res: request.Response): DeviceView {
    return (res.body as { device: DeviceView }).device
  }

  function errorCodeOf(res: request.Response): string {
    return (res.body as { error: { code: string } }).error.code
  }

  async function deviceEnroll(code: string, overrides?: Partial<{ hardwareKeyFingerprint: string; label: string }>) {
    return request(httpServer)
      .post('/device/v1/enroll')
      .send({
        code,
        hardwareKeyFingerprint: overrides?.hardwareKeyFingerprint ?? 'device-stub-fingerprint-1',
        label: overrides?.label,
      })
  }

  it('redeems a code generated by ops with no operator session at all, audited with a device actor', async () => {
    const code = codeOf(await generateCode())
    const res = await deviceEnroll(code, { hardwareKeyFingerprint: 'device-stub-fingerprint-1', label: 'Kitchen Terminal' })
    expect(res.status).toBe(201)
    const body = deviceOf(res)
    expect(body).toMatchObject({ tenantId, outletId, type: 'pos', role: 'terminal', status: 'active', label: 'Kitchen Terminal' })

    const deviceRow = await prisma.device.findUnique({ where: { id: body.id } })
    expect(deviceRow?.status).toBe('active')
    expect(deviceRow?.hardwareKeyFingerprint).toBe('device-stub-fingerprint-1')

    expect((await prisma.enrolmentCode.findFirst({ where: { tenantId } }))?.usedAt).not.toBeNull()

    const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'device.enrolled' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actorId).toBeNull()
    expect(audit[0]?.actorEmail).toBe('device:device-stub-')
  })

  it('rejects an unknown code with 400 code_invalid', async () => {
    const res = await deviceEnroll('ZZZ-ZZZ')
    expect(res.status).toBe(400)
    expect(errorCodeOf(res)).toBe('code_invalid')
    expect(await prisma.device.count({ where: { tenantId } })).toBe(0)
  })

  it('rejects an expired code with 400 code_expired, even though it was never used', async () => {
    const code = codeOf(await generateCode())
    await prisma.enrolmentCode.updateMany({ where: { tenantId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const res = await deviceEnroll(code)
    expect(res.status).toBe(400)
    expect(errorCodeOf(res)).toBe('code_expired')
    expect(await prisma.device.count({ where: { tenantId } })).toBe(0)
  })

  it('rejects a reused code on the second attempt with 409 code_already_used', async () => {
    const code = codeOf(await generateCode())
    const first = await deviceEnroll(code, { hardwareKeyFingerprint: 'fp-1' })
    expect(first.status).toBe(201)
    const second = await deviceEnroll(code, { hardwareKeyFingerprint: 'fp-2' })
    expect(second.status).toBe(409)
    expect(errorCodeOf(second)).toBe('code_already_used')
    expect(await prisma.device.count({ where: { tenantId } })).toBe(1)
  })

  it('a code generated by ops can still be redeemed through the ops-realm enroll endpoint', async () => {
    const code = codeOf(await generateCode())
    const res = await request(httpServer)
      .post('/ops/v1/devices/enroll')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ code, hardwareKeyFingerprint: 'ops-stub-fingerprint-1' })
    expect(res.status).toBe(201)
    const body = deviceOf(res)
    expect(body).toMatchObject({ tenantId, outletId, type: 'pos', status: 'active' })

    const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'device.enrolled' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actorEmail).toBe(EMAIL)
  })

  it('ignores any Authorization header sent - no guard checks it on this route', async () => {
    const code = codeOf(await generateCode())
    const res = await request(httpServer)
      .post('/device/v1/enroll')
      .set('Authorization', 'Bearer this-is-not-a-real-token')
      .send({ code, hardwareKeyFingerprint: 'device-stub-fingerprint-2' })
    expect(res.status).toBe(201)
  })

  it('validates the request body', async () => {
    const res = await request(httpServer).post('/device/v1/enroll').send({ code: '' })
    expect(res.status).toBe(400)
  })
})
