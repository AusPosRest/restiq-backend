// Issue #117 success criteria, end to end: deactivate/reactivate round-trip
// with audit rows, soft delete refuses open activity and hides the tenant
// from every directory/KPI read, and a blocked tenant's realm guards reject
// admin/pos traffic at the guard layer regardless of which route is hit.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, signPosToken, uuidv7 } from '../src/platform'

const EMAIL = 'lifecycle-operator@restiq.example'

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

describe('tenant lifecycle: deactivate / reactivate / soft-delete (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let token: string
  let operatorId: string
  let tenantId: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: EMAIL } })
    const operator = await prisma.operatorUser.create({
      data: { email: EMAIL, passwordHash: await argon2.hash('irrelevant-here') },
    })
    operatorId = operator.id
    token = signOpsToken({ id: operator.id, email: operator.email })

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
        name: 'Lifecycle Cafe',
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
  })

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  function errorCodeOf(res: request.Response): string {
    return (res.body as { error: { code: string } }).error.code
  }

  describe('POST /ops/v1/tenants/:id/deactivate', () => {
    it('deactivates an active tenant, audited with reason; a second deactivate conflicts', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/deactivate`)).send({
        reason: 'Non-payment beyond arrears window',
      })
      expect(res.status).toBe(200)
      expect((res.body as { tenant: { status: string } }).tenant.status).toBe('inactive')
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe('inactive')

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'tenant.deactivated' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ actorId: operatorId, actorEmail: EMAIL, reason: 'Non-payment beyond arrears window' })

      const again = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/deactivate`)).send({ reason: 'x' })
      expect(again.status).toBe(409)
    })

    it('rejects deactivating a provisioning tenant', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'provisioning' } })
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/deactivate`)).send({ reason: 'x' })
      expect(res.status).toBe(409)
    })

    it('rejects deactivate without a reason and writes nothing', async () => {
      const before = await prisma.auditEvent.count()
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/deactivate`)).send({})
      expect(res.status).toBe(400)
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe('active')
      expect(await prisma.auditEvent.count()).toBe(before)
    })

    it('404s for an unknown tenant', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${uuidv7()}/deactivate`)).send({ reason: 'x' })
      expect(res.status).toBe(404)
    })

    it('rejects without an ops token', async () => {
      const res = await request(httpServer).post(`/ops/v1/tenants/${tenantId}/deactivate`).send({ reason: 'x' })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /ops/v1/tenants/:id/reactivate', () => {
    it('reactivates an inactive tenant, audited; reactivating an active tenant conflicts', async () => {
      await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/deactivate`)).send({ reason: 'first' })

      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/reactivate`)).send({
        reason: 'Payment received',
      })
      expect(res.status).toBe(200)
      expect((res.body as { tenant: { status: string } }).tenant.status).toBe('active')
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe('active')

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'tenant.reactivated' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.reason).toBe('Payment received')

      const again = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/reactivate`)).send({ reason: 'x' })
      expect(again.status).toBe(409)
      expect(errorCodeOf(again)).toBe('conflict')
    })

    it('rejects reactivating a provisioning tenant', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'provisioning' } })
      const res = await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/reactivate`)).send({ reason: 'x' })
      expect(res.status).toBe(409)
    })
  })

  describe('DELETE /ops/v1/tenants/:id (soft delete)', () => {
    it('soft deletes a tenant with no open activity: gone from detail, list and the active_tenants KPI', async () => {
      const before = (await authed(request(httpServer).get('/ops/v1/dashboard/kpis/active_tenants'))).body as { value: number }

      const res = await authed(request(httpServer).delete(`/ops/v1/tenants/${tenantId}`)).send({ reason: 'Tenant churned' })
      expect(res.status).toBe(200)
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.deletedAt).not.toBeNull()
      // The status itself is untouched by a soft delete.
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.status).toBe('active')

      const detail = await authed(request(httpServer).get(`/ops/v1/tenants/${tenantId}`))
      expect(detail.status).toBe(404)

      const list = (await authed(request(httpServer).get('/ops/v1/tenants'))).body as { tenants: Array<{ id: string }> }
      expect(list.tenants.map((t) => t.id)).not.toContain(tenantId)

      const after = (await authed(request(httpServer).get('/ops/v1/dashboard/kpis/active_tenants'))).body as { value: number }
      expect(after.value).toBe(before.value - 1)

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'tenant.deleted' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.reason).toBe('Tenant churned')
    })

    it('refuses to delete a tenant with an open order', async () => {
      const brand = await prisma.brand.create({ data: { tenantId, name: 'Brand' } })
      const outlet = await prisma.outlet.create({
        data: { tenantId, brandId: brand.id, name: 'Outlet 1', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
      })
      await prisma.order.create({ data: { tenantId, outletId: outlet.id, status: 'open' } })

      const res = await authed(request(httpServer).delete(`/ops/v1/tenants/${tenantId}`)).send({ reason: 'x' })
      expect(res.status).toBe(409)
      expect(errorCodeOf(res)).toBe('tenant_has_open_activity')
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.deletedAt).toBeNull()
    })

    it('refuses to delete a tenant with an open bill', async () => {
      const brand = await prisma.brand.create({ data: { tenantId, name: 'Brand' } })
      const outlet = await prisma.outlet.create({
        data: { tenantId, brandId: brand.id, name: 'Outlet 1', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
      })
      const order = await prisma.order.create({ data: { tenantId, outletId: outlet.id, status: 'closed' } })
      await prisma.bill.create({
        data: { tenantId, outletId: outlet.id, orderId: order.id, subtotalMinor: 10000n, taxMinor: 0n, status: 'open' },
      })

      const res = await authed(request(httpServer).delete(`/ops/v1/tenants/${tenantId}`)).send({ reason: 'x' })
      expect(res.status).toBe(409)
      expect(errorCodeOf(res)).toBe('tenant_has_open_activity')
    })

    it('rejects delete without a reason and writes nothing', async () => {
      const before = await prisma.auditEvent.count()
      const res = await authed(request(httpServer).delete(`/ops/v1/tenants/${tenantId}`)).send({})
      expect(res.status).toBe(400)
      expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.deletedAt).toBeNull()
      expect(await prisma.auditEvent.count()).toBe(before)
    })

    it('404s for an unknown tenant', async () => {
      const res = await authed(request(httpServer).delete(`/ops/v1/tenants/${uuidv7()}`)).send({ reason: 'x' })
      expect(res.status).toBe(404)
    })
  })

  describe('guard enforcement: a blocked tenant is rejected on every realm, not just ops', () => {
    it('rejects an admin token for an inactive tenant with 403 tenant_inactive', async () => {
      await authed(request(httpServer).post(`/ops/v1/tenants/${tenantId}/deactivate`)).send({ reason: 'x' })

      const adminToken = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@lifecycle.example' })
      const res = await request(httpServer).get('/admin/v1/branding').set('Authorization', `Bearer ${adminToken}`)
      expect(res.status).toBe(403)
      expect(errorCodeOf(res)).toBe('tenant_inactive')
    })

    it('rejects a pos token for a soft-deleted tenant with 403 tenant_inactive', async () => {
      await authed(request(httpServer).delete(`/ops/v1/tenants/${tenantId}`)).send({ reason: 'x' })

      const posToken = signPosToken({ id: uuidv7(), tenantId, outletId: uuidv7(), name: 'Staffer' })
      const res = await request(httpServer).get('/pos/v1/menu').set('Authorization', `Bearer ${posToken}`)
      expect(res.status).toBe(403)
      expect(errorCodeOf(res)).toBe('tenant_inactive')
    })

    it('still allows an admin token for an active tenant through', async () => {
      const adminToken = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@lifecycle.example' })
      const res = await request(httpServer).get('/admin/v1/branding').set('Authorization', `Bearer ${adminToken}`)
      expect(res.status).toBe(200)
    })
  })
})
