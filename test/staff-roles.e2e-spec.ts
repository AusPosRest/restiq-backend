// tenant-admin/CAP-7 success criteria, end to end: an owner can list the six
// seeded system roles, create/update staff scoped to their own tenant with
// one of those roles, and never a free-text or foreign-tenant role (400); PIN
// issuance stores only an argon2 hash and returns the raw PIN once; PIN
// revoke requires a reason, is audited (AD-6), and a revoked PIN can never
// authenticate again; the go-live checklist's 'staff' step flips on the
// first staff member created for the tenant.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, uuidv7 } from '../src/platform'

const SYSTEM_ROLES = ['Owner', 'Manager', 'Cashier', 'Waiter', 'Kitchen', 'Accountant']

interface RoleView {
  id: string
  name: string
  isSystem: boolean
}
interface StaffView {
  id: string
  tenantId: string
  name: string
  email: string | null
  roleId: string
  roleName: string
  pinStatus: 'none' | 'active' | 'revoked'
  createdAt: string
  updatedAt: string
}
interface ChecklistStepView {
  step: string
  completed: boolean
}
interface ChecklistBody {
  steps: ChecklistStepView[]
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
  const token = signAdminToken({ id: uuidv7(), tenantId, email: `owner-${tenantId}@spiceroute.example` })
  return { tenantId, token }
}

// Same seed the Platform Console onboarding wizard writes per tenant
// (tenants.service.ts SYSTEM_ROLES) - CAP-7 only ever assigns from this set.
async function seedRoles(prisma: PrismaClient, tenantId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {}
  for (const name of SYSTEM_ROLES) {
    const role = await prisma.role.create({ data: { tenantId, name, isSystem: true } })
    ids[name] = role.id
  }
  return ids
}

describe('/admin/v1/staff and /admin/v1/roles (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)

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

  describe('GET /admin/v1/roles', () => {
    it('lists the six seeded system roles for the signed-in tenant', async () => {
      const { tenantId, token } = await createOwner(prisma)
      await seedRoles(prisma, tenantId)

      const res = await authed(request(httpServer).get('/admin/v1/roles'), token)
      expect(res.status).toBe(200)
      const roles = res.body as RoleView[]
      expect(roles).toHaveLength(6)
      expect(roles.map((r) => r.name).sort()).toEqual([...SYSTEM_ROLES].sort())
      expect(roles.every((r) => r.isSystem)).toBe(true)
    })

    it('never returns another tenant\'s roles (cross-tenant isolation)', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      await seedRoles(prisma, ownerA.tenantId)
      await seedRoles(prisma, ownerB.tenantId)

      const res = await authed(request(httpServer).get('/admin/v1/roles'), ownerA.token)
      const roles = res.body as RoleView[]
      expect(roles).toHaveLength(6)
    })

    it('rejects without an admin token', async () => {
      const res = await request(httpServer).get('/admin/v1/roles')
      expect(res.status).toBe(401)
    })
  })

  describe('POST /admin/v1/staff', () => {
    it('creates a staff member with a seeded role', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)

      const res = await authed(request(httpServer).post('/admin/v1/staff'), token).send({
        name: 'Priya Nair',
        email: 'priya@spiceroute.example',
        roleId: roles.Waiter,
      })
      expect(res.status).toBe(201)
      const body = res.body as StaffView
      expect(body).toMatchObject({ tenantId, name: 'Priya Nair', email: 'priya@spiceroute.example', roleId: roles.Waiter, roleName: 'Waiter', pinStatus: 'none' })

      const row = await prisma.staffUser.findUnique({ where: { id: body.id } })
      expect(row?.tenantId).toBe(tenantId)
    })

    it('rejects a roleId that is not one of this tenant\'s seeded roles (400)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      await seedRoles(prisma, tenantId)

      const res = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Fake Role', roleId: uuidv7() })
      expect(res.status).toBe(400)
    })

    it('rejects a roleId that belongs to a different tenant (400, cross-tenant isolation)', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      const rolesB = await seedRoles(prisma, ownerB.tenantId)
      await seedRoles(prisma, ownerA.tenantId)

      const res = await authed(request(httpServer).post('/admin/v1/staff'), ownerA.token).send({ name: 'Smuggled', roleId: rolesB.Manager })
      expect(res.status).toBe(400)
    })

    it('rejects without an admin token', async () => {
      const res = await request(httpServer).post('/admin/v1/staff').send({ name: 'x', roleId: uuidv7() })
      expect(res.status).toBe(401)
    })

    it('flips the go-live checklist\'s staff step on the first staff member created', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)

      const before = await authed(request(httpServer).get('/admin/v1/checklist'), token)
      expect(((before.body as ChecklistBody).steps.find((s) => s.step === 'staff') as ChecklistStepView).completed).toBe(false)

      await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'First Staff', roleId: roles.Cashier })

      const after = await authed(request(httpServer).get('/admin/v1/checklist'), token)
      expect(((after.body as ChecklistBody).steps.find((s) => s.step === 'staff') as ChecklistStepView).completed).toBe(true)

      // A second staff member does not re-toggle or error on the upsert.
      const res2 = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Second Staff', roleId: roles.Kitchen })
      expect(res2.status).toBe(201)
    })
  })

  describe('PATCH /admin/v1/staff/:id', () => {
    it('updates name without a reason (routine, not audited)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const created = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Priya Nair', roleId: roles.Waiter })
      const staffId = (created.body as StaffView).id

      const res = await authed(request(httpServer).patch(`/admin/v1/staff/${staffId}`), token).send({ name: 'Priya N.' })
      expect(res.status).toBe(200)
      expect(res.body as StaffView).toMatchObject({ name: 'Priya N.', roleId: roles.Waiter })
    })

    it('changes role with a reason, and audits it (AD-6: role change is security-relevant)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const created = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Priya Nair', roleId: roles.Waiter })
      const staffId = (created.body as StaffView).id

      const res = await authed(request(httpServer).patch(`/admin/v1/staff/${staffId}`), token).send({
        roleId: roles.Cashier,
        reason: 'Promoted to front-of-house lead',
      })
      expect(res.status).toBe(200)
      expect(res.body as StaffView).toMatchObject({ roleId: roles.Cashier, roleName: 'Cashier' })

      const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'staff.role_changed' } })
      expect(audit).toMatchObject({ reason: 'Promoted to front-of-house lead' })
    })

    it('rejects a role change with no reason (400)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const created = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Priya Nair', roleId: roles.Waiter })
      const staffId = (created.body as StaffView).id

      const res = await authed(request(httpServer).patch(`/admin/v1/staff/${staffId}`), token).send({ roleId: roles.Cashier })
      expect(res.status).toBe(400)

      const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'staff.role_changed' } })
      expect(audit).toBeNull()
    })

    it('re-sending the same roleId is not a role change - no reason required', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const created = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Priya Nair', roleId: roles.Waiter })
      const staffId = (created.body as StaffView).id

      const res = await authed(request(httpServer).patch(`/admin/v1/staff/${staffId}`), token).send({ roleId: roles.Waiter })
      expect(res.status).toBe(200)
    })

    it('rejects a roleId outside the seeded set (400)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const created = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Priya Nair', roleId: roles.Waiter })
      const staffId = (created.body as StaffView).id

      const res = await authed(request(httpServer).patch(`/admin/v1/staff/${staffId}`), token).send({ roleId: uuidv7(), reason: 'x' })
      expect(res.status).toBe(400)
    })

    it('404s for a staff member belonging to another tenant (cross-tenant isolation)', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      const rolesB = await seedRoles(prisma, ownerB.tenantId)
      await seedRoles(prisma, ownerA.tenantId)
      const created = await authed(request(httpServer).post('/admin/v1/staff'), ownerB.token).send({ name: 'B Staff', roleId: rolesB.Manager })
      const staffId = (created.body as StaffView).id

      const res = await authed(request(httpServer).patch(`/admin/v1/staff/${staffId}`), ownerA.token).send({ name: 'Hijacked' })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /admin/v1/staff/:id/pin and /admin/v1/staff/:id/revoke-pin', () => {
    async function createStaff(token: string, roleId: string): Promise<StaffView> {
      const res = await authed(request(httpServer).post('/admin/v1/staff'), token).send({ name: 'Priya Nair', roleId })
      return res.body as StaffView
    }

    it('issues a 4-digit PIN, storing only its argon2 hash', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const staff = await createStaff(token, roles.Waiter)

      const res = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/pin`), token)
      expect(res.status).toBe(201)
      const pin = (res.body as { pin: string }).pin
      expect(pin).toMatch(/^\d{4}$/)

      const row = await prisma.staffUser.findUnique({ where: { id: staff.id } })
      expect(row?.pinHash).toBeTruthy()
      expect(row?.pinHash).not.toBe(pin)
      expect(await argon2.verify(row?.pinHash as string, pin)).toBe(true)
      expect(row?.pinRevokedAt).toBeNull()
    })

    it('revoke-pin requires a reason (400 without one)', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const staff = await createStaff(token, roles.Waiter)
      await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/pin`), token)

      const res = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/revoke-pin`), token).send({})
      expect(res.status).toBe(400)
    })

    it('revokes a PIN with a reason, audits the action (AD-6), and the PIN can never authenticate again', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const staff = await createStaff(token, roles.Waiter)
      const issued = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/pin`), token)
      const pin = (issued.body as { pin: string }).pin

      const res = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/revoke-pin`), token).send({ reason: 'Staff member left the outlet' })
      expect(res.status).toBe(200)
      expect((res.body as StaffView).pinStatus).toBe('revoked')

      const row = await prisma.staffUser.findUnique({ where: { id: staff.id } })
      expect(row?.pinRevokedAt).not.toBeNull()
      // The hash is untouched (history preserved) but a revoked PIN is never
      // a valid credential again - any future PIN-login surface must check
      // pinRevokedAt, not just hash equality.
      expect(await argon2.verify(row?.pinHash as string, pin)).toBe(true)
      expect(row?.pinRevokedAt).not.toBeNull()

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'staff.pin_revoked' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]?.reason).toBe('Staff member left the outlet')
      expect(audit[0]?.actorEmail).toBeTruthy()
    })

    it('conflicts revoking a PIN that is already revoked or was never issued', async () => {
      const { tenantId, token } = await createOwner(prisma)
      const roles = await seedRoles(prisma, tenantId)
      const staff = await createStaff(token, roles.Waiter)

      const neverIssued = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/revoke-pin`), token).send({ reason: 'x' })
      expect(neverIssued.status).toBe(409)

      await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/pin`), token)
      await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/revoke-pin`), token).send({ reason: 'first revoke' })
      const secondRevoke = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/revoke-pin`), token).send({ reason: 'second revoke' })
      expect(secondRevoke.status).toBe(409)
    })

    it('404s issuing/revoking a PIN for a staff member belonging to another tenant', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      const rolesB = await seedRoles(prisma, ownerB.tenantId)
      await seedRoles(prisma, ownerA.tenantId)
      const staff = await createStaff(ownerB.token, rolesB.Manager)

      const pinRes = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/pin`), ownerA.token)
      expect(pinRes.status).toBe(404)

      const revokeRes = await authed(request(httpServer).post(`/admin/v1/staff/${staff.id}/revoke-pin`), ownerA.token).send({ reason: 'x' })
      expect(revokeRes.status).toBe(404)
    })
  })

  describe('GET /admin/v1/staff', () => {
    it('lists staff scoped to the signed-in tenant', async () => {
      const ownerA = await createOwner(prisma, 'Tenant A')
      const ownerB = await createOwner(prisma, 'Tenant B')
      const rolesA = await seedRoles(prisma, ownerA.tenantId)
      const rolesB = await seedRoles(prisma, ownerB.tenantId)
      await authed(request(httpServer).post('/admin/v1/staff'), ownerA.token).send({ name: 'A Staff', roleId: rolesA.Waiter })
      await authed(request(httpServer).post('/admin/v1/staff'), ownerB.token).send({ name: 'B Staff', roleId: rolesB.Manager })

      const res = await authed(request(httpServer).get('/admin/v1/staff'), ownerA.token)
      expect(res.status).toBe(200)
      const body = res.body as { staff: StaffView[] }
      expect(body.staff).toHaveLength(1)
      expect(body.staff[0]?.name).toBe('A Staff')
    })
  })
})
