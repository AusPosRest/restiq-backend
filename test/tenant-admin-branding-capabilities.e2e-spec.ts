// CAP-10 success criteria, end to end:
//  - outlet listing is scoped to the signed-in tenant (cross-tenant isolation, NFR-8)
//  - branding tokens round-trip through GET/PUT and merge rather than clobber
//  - a capability toggle persists and reads back immediately, scoped per outlet
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'

interface OutletBody {
  id: string
  name: string
  address: string
  type: string
  timezone: string
}
interface BrandingBody {
  primaryColor: string | null
  secondaryColor: string | null
  accentColor: string | null
  surfaceColor: string | null
  font: string | null
  cornerRadiusPx: number | null
  logoUrl: string | null
  receiptHeader: string | null
  receiptFooter: string | null
}
interface CapabilityBody {
  key: string
  enabled: boolean
}
interface ErrorBody {
  error: { code: string; message: string }
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // pos/CAP-9 refunds: CreditNote FKs to bills/staff_users (RESTRICT) and
  // cascades to its own CreditNoteLine rows - deleted first so later
  // bill/order_line/staff_user deletes below never hit a live FK.
  await prisma.creditNote.deleteMany()
  await prisma.orderLineModifier.deleteMany()
  await prisma.orderLine.deleteMany()
  // shifts/cash_movements (pos/CAP-10) restrict-delete tenants/outlets/staff;
  // wiped first for the same reason invoice/subscription is below.
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
  await prisma.tender.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.billNumberCounter.deleteMany()
  await prisma.tokenNumberCounter.deleteMany()
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

async function createOwner(prisma: PrismaClient, name = 'Spice Route Hospitality'): Promise<{ tenantId: string; token: string }> {
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
  const token = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@spiceroute.example' })
  return { tenantId, token }
}

async function createOutlet(prisma: PrismaClient, tenantId: string, name = 'Indiranagar'): Promise<string> {
  const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
  const outlet = await prisma.outlet.create({
    data: { tenantId, brandId: brand.id, name, address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
  })
  return outlet.id
}

describe('/admin/v1/outlets, /admin/v1/branding (e2e)', () => {
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

  describe('outlets', () => {
    it('lists outlets scoped to the signed-in tenant only', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId, 'Indiranagar')

      const res = await authed(request(httpServer).get('/admin/v1/outlets'), token)
      expect(res.status).toBe(200)
      const body = res.body as OutletBody[]
      expect(body).toHaveLength(1)
      expect(body[0]).toEqual({ id: outletId, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' })
    })

    it('never returns another tenant’s outlets (cross-tenant isolation, NFR-8)', async () => {
      const owner = await createOwner(prisma, 'Spice Route Hospitality')
      const other = await createOwner(prisma, 'Curry Leaf Kitchens')
      await createOutlet(prisma, owner.tenantId, 'Indiranagar')
      await createOutlet(prisma, other.tenantId, 'Koramangala')

      const res = await authed(request(httpServer).get('/admin/v1/outlets'), owner.token)
      expect(res.status).toBe(200)
      const body = res.body as OutletBody[]
      expect(body).toHaveLength(1)
      expect(body[0]?.name).toBe('Indiranagar')
      expect(body.some((o) => o.name === 'Koramangala')).toBe(false)
    })

    it('rejects a request with no admin session', async () => {
      const res = await request(httpServer).get('/admin/v1/outlets')
      expect(res.status).toBe(401)
    })
  })

  describe('branding', () => {
    it('returns all-null branding for a tenant that has never saved any', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).get('/admin/v1/branding'), token)
      expect(res.status).toBe(200)
      const body = res.body as BrandingBody
      expect(body.primaryColor).toBeNull()
      expect(body.receiptHeader).toBeNull()
    })

    it('round-trips saved tokens through GET after PUT', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const putRes = await authed(request(httpServer).put('/admin/v1/branding'), token).send({
        primaryColor: '#8D2028',
        secondaryColor: '#F39B08',
        accentColor: '#FDE58A',
        surfaceColor: '#451A1A',
        font: 'Hanken Grotesk',
        cornerRadiusPx: 8,
        receiptHeader: 'GST Number: 27ABCDE1234F1Z5',
        receiptFooter: 'Thank you for visiting!',
      })
      expect(putRes.status).toBe(200)

      const getRes = await authed(request(httpServer).get('/admin/v1/branding'), token)
      expect(getRes.status).toBe(200)
      const body = getRes.body as BrandingBody
      expect(body).toEqual({
        primaryColor: '#8D2028',
        secondaryColor: '#F39B08',
        accentColor: '#FDE58A',
        surfaceColor: '#451A1A',
        font: 'Hanken Grotesk',
        cornerRadiusPx: 8,
        logoUrl: null,
        receiptHeader: 'GST Number: 27ABCDE1234F1Z5',
        receiptFooter: 'Thank you for visiting!',
      })
      expect(await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }).then((t) => t.brandingTokens)).toEqual({
        primaryColor: '#8D2028',
        secondaryColor: '#F39B08',
        accentColor: '#FDE58A',
        surfaceColor: '#451A1A',
        font: 'Hanken Grotesk',
        cornerRadiusPx: 8,
        receiptHeader: 'GST Number: 27ABCDE1234F1Z5',
        receiptFooter: 'Thank you for visiting!',
      })
    })

    it('merges a partial PUT into existing tokens rather than clobbering them', async () => {
      const { token } = await createOwner(prisma)
      await authed(request(httpServer).put('/admin/v1/branding'), token).send({ primaryColor: '#8D2028', receiptHeader: 'Header A' })

      const res = await authed(request(httpServer).put('/admin/v1/branding'), token).send({ receiptFooter: 'Footer B' })
      expect(res.status).toBe(200)
      const body = res.body as BrandingBody
      expect(body.primaryColor).toBe('#8D2028')
      expect(body.receiptHeader).toBe('Header A')
      expect(body.receiptFooter).toBe('Footer B')
    })

    it('rejects a non-hex color (400)', async () => {
      const { token } = await createOwner(prisma)
      const res = await authed(request(httpServer).put('/admin/v1/branding'), token).send({ primaryColor: 'not-a-color' })
      expect(res.status).toBe(400)
      expect((res.body as ErrorBody).error.code).toBe('validation_failed')
    })

    it('never writes an audit row for a branding change (routine content edit)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      await authed(request(httpServer).put('/admin/v1/branding'), token).send({ primaryColor: '#8D2028' })
      expect(await prisma.auditEvent.count({ where: { tenantId } })).toBe(0)
    })
  })

  describe('outlet capabilities', () => {
    it('starts with no capabilities recorded for a fresh outlet', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)
      const res = await authed(request(httpServer).get(`/admin/v1/outlets/${outletId}/capabilities`), token)
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('toggling a capability persists and is readable immediately', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const outletId = await createOutlet(prisma, tenantId)

      const patchRes = await authed(request(httpServer).patch(`/admin/v1/outlets/${outletId}/capabilities/qr_ordering`), token).send({ enabled: true })
      expect(patchRes.status).toBe(200)
      expect(patchRes.body).toEqual({ key: 'qr_ordering', enabled: true })

      const getRes = await authed(request(httpServer).get(`/admin/v1/outlets/${outletId}/capabilities`), token)
      const body = getRes.body as CapabilityBody[]
      expect(body).toEqual([{ key: 'qr_ordering', enabled: true }])

      const offRes = await authed(request(httpServer).patch(`/admin/v1/outlets/${outletId}/capabilities/qr_ordering`), token).send({ enabled: false })
      expect(offRes.body).toEqual({ key: 'qr_ordering', enabled: false })
    })

    it('rejects toggling a capability for another tenant’s outlet (404, not leaked as 403)', async () => {
      const owner = await createOwner(prisma, 'Spice Route Hospitality')
      const other = await createOwner(prisma, 'Curry Leaf Kitchens')
      const otherOutletId = await createOutlet(prisma, other.tenantId, 'Koramangala')

      const res = await authed(request(httpServer).patch(`/admin/v1/outlets/${otherOutletId}/capabilities/kiosk`), owner.token).send({ enabled: true })
      expect(res.status).toBe(404)
    })
  })
})
