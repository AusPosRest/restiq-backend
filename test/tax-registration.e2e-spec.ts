import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'
import { Country } from '../src/generated/prisma/client'

interface TaxRegistrationBody {
  country: string
  registrationType: 'gstin' | 'abn'
  registrationNumber: string | null
  legalEntityName: string
  taxProfile: string
  fssaiLicense: string | null
  compositionScheme: boolean
  gstRegistered: boolean
}
interface ErrorBody {
  error: { code: string; message: string }
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
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

interface OwnerFixture {
  tenantId: string
  token: string
}

async function createOwner(prisma: PrismaClient, name = 'Spice Route Hospitality', country: Country = 'IN'): Promise<OwnerFixture> {
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
      country,
      status: 'active',
      plan: 'standard',
      billingPeriod: 'monthly',
    },
  })
  const token = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@spiceroute.example' })
  return { tenantId, token }
}

interface SeedTaxRegistration {
  registrationNumber: string
  legalEntityName: string
  taxProfile: string
  registrationType?: 'gstin' | 'abn'
  fssaiLicense?: string
  compositionScheme?: boolean
  gstRegistered?: boolean
}

async function seedTenantTaxRegistration(prisma: PrismaClient, tenantId: string, data: SeedTaxRegistration): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true } })
  await prisma.tenantTaxRegistration.create({
    data: {
      tenantId,
      registrationType: data.registrationType ?? (tenant.country === 'IN' ? 'gstin' : 'abn'),
      registrationNumber: data.registrationNumber,
      legalEntityName: data.legalEntityName,
      taxProfile: data.taxProfile,
      gstRegistered: data.gstRegistered ?? true,
      fssaiLicense: data.fssaiLicense,
      compositionScheme: data.compositionScheme ?? false,
    },
  })
}

describe('/admin/v1/tax-registration', () => {
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

  it('returns tenant defaults when no TenantTaxRegistration row exists yet', async () => {
    const { tenantId, token } = await createOwner(prisma)

    const res = await authed(request(httpServer).get('/admin/v1/tax-registration'), token)
    expect(res.status).toBe(200)
    const body = res.body as TaxRegistrationBody
    expect(body.country).toBe('IN')
    expect(body.registrationType).toBe('gstin')
    expect(body.registrationNumber).toBeNull()
    expect(body.legalEntityName).toBe((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name)
    expect(body.taxProfile).toBe('')
    expect(body.fssaiLicense).toBeNull()
    expect(body.compositionScheme).toBe(false)
    expect(body.gstRegistered).toBe(true)
  })

  it('PUT merges caller-writable fields into the existing TenantTaxRegistration row', async () => {
    const { tenantId, token } = await createOwner(prisma)
    await seedTenantTaxRegistration(prisma, tenantId, {
      registrationNumber: '22AAACC1122A1ZZ',
      legalEntityName: 'Old Name',
      taxProfile: 'India GST',
      fssaiLicense: 'FSSAI-OLD',
      compositionScheme: false,
    })

    const res = await authed(request(httpServer).put('/admin/v1/tax-registration'), token).send({
      legalEntityName: 'New Name',
      compositionScheme: true,
    })
    expect(res.status).toBe(200)
    const body = res.body as TaxRegistrationBody
    expect(body.registrationNumber).toBe('22AAACC1122A1ZZ')
    expect(body.legalEntityName).toBe('New Name')
    expect(body.taxProfile).toBe('India GST')
    expect(body.fssaiLicense).toBe('FSSAI-OLD')
    expect(body.compositionScheme).toBe(true)
    expect(body.gstRegistered).toBe(true)

    const db = await prisma.tenantTaxRegistration.findFirstOrThrow({ where: { tenantId } })
    expect(db.legalEntityName).toBe('New Name')
    expect(db.compositionScheme).toBe(true)
    expect(db.fssaiLicense).toBe('FSSAI-OLD')
  })

  it('rejects gstRegistered=false for IN tenants', async () => {
    const { token } = await createOwner(prisma, 'Indian Tenant', 'IN')
    const seed = await authed(request(httpServer).put('/admin/v1/tax-registration'), token).send({
      registrationNumber: '22AAABC1111A1ZZ',
      legalEntityName: 'Indian Tenant',
      taxProfile: 'India GST',
      gstRegistered: false,
    })
    expect(seed.status).toBe(400)
    expect((seed.body as ErrorBody).error.code).toBe('validation_failed')
  })

  it('stores and returns gstRegistered for AU tenants', async () => {
    const { tenantId, token } = await createOwner(prisma, 'Tenant AU', 'AU')
    const createRes = await authed(request(httpServer).put('/admin/v1/tax-registration'), token).send({
      registrationNumber: '22AAAAC1111A1ZZ',
      legalEntityName: 'Tenant AU',
      taxProfile: 'Australia GST',
      gstRegistered: false,
    })
    expect(createRes.status).toBe(200)
    expect((createRes.body as TaxRegistrationBody).gstRegistered).toBe(false)

    const getRes = await authed(request(httpServer).get('/admin/v1/tax-registration'), token)
    expect(getRes.status).toBe(200)
    expect((getRes.body as TaxRegistrationBody).gstRegistered).toBe(false)

    const db = await prisma.tenantTaxRegistration.findFirstOrThrow({ where: { tenantId } })
    expect(db.gstRegistered).toBe(false)
  })

  it('creates a TenantTaxRegistration row on PUT when one did not exist', async () => {
    const { tenantId, token } = await createOwner(prisma)
    const res = await authed(request(httpServer).put('/admin/v1/tax-registration'), token).send({
      registrationNumber: '22AAACX1122A1ZZ',
      legalEntityName: 'New Tenant',
      taxProfile: 'India GST - CGST/SGST split',
    })

    expect(res.status).toBe(200)
    expect((res.body as TaxRegistrationBody).registrationNumber).toBe('22AAACX1122A1ZZ')

    const db = await prisma.tenantTaxRegistration.findFirstOrThrow({ where: { tenantId: tenantId } })
    expect(db.registrationNumber).toBe('22AAACX1122A1ZZ')
    expect(db.legalEntityName).toBe('New Tenant')
    expect(db.taxProfile).toBe('India GST - CGST/SGST split')
  })

  it('returns 409 conflict if registrationNumber belongs to another tenant', async () => {
    const owner = await createOwner(prisma, 'Tenant A')
    const other = await createOwner(prisma, 'Tenant B')
    await seedTenantTaxRegistration(prisma, owner.tenantId, {
      registrationNumber: '22AAAA1111A1ZZ5',
      legalEntityName: 'Tenant A',
      taxProfile: 'India GST',
    })
    const otherReg = await authed(request(httpServer).put('/admin/v1/tax-registration'), other.token).send({
      registrationNumber: '22AAAA1111A1ZZ5',
      legalEntityName: 'Tenant B',
      taxProfile: 'India GST',
    })
    expect(otherReg.status).toBe(409)
    expect((otherReg.body as ErrorBody).error.code).toBe('conflict')
  })

  it('isolates GET and PUT to the calling owner tenant only', async () => {
    const ownerA = await createOwner(prisma, 'Tenant A')
    const ownerB = await createOwner(prisma, 'Tenant B')
    await seedTenantTaxRegistration(prisma, ownerA.tenantId, {
      registrationNumber: '22AAAAB1111A1ZZ',
      legalEntityName: 'Tenant A',
      taxProfile: 'India GST',
    })
    await seedTenantTaxRegistration(prisma, ownerB.tenantId, {
      registrationNumber: '22BBBBB1111A1ZZ',
      legalEntityName: 'Tenant B',
      taxProfile: 'Australia GST',
      registrationType: 'abn',
      compositionScheme: true,
    })

    const getA = await authed(request(httpServer).get('/admin/v1/tax-registration'), ownerA.token)
    expect(getA.status).toBe(200)
    expect((getA.body as TaxRegistrationBody).registrationNumber).toBe('22AAAAB1111A1ZZ')

    const putA = await authed(request(httpServer).put('/admin/v1/tax-registration'), ownerA.token).send({
      legalEntityName: 'Tenant A Updated',
    })
    expect(putA.status).toBe(200)
    expect((await prisma.tenantTaxRegistration.findFirstOrThrow({ where: { tenantId: ownerB.tenantId } })).legalEntityName).toBe('Tenant B')
  })
})
