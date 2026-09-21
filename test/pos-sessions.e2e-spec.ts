// restiq-backend#169 regression: a POS/KDS token stops working the moment the
// staff member's access changes (PIN revoked or reissued, role changed,
// logout), a token without a session version is refused, and the API - not
// just the UI - refuses actions the role may not do.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signPosToken, uuidv7 } from '../src/platform'

// Full table list (not just this file's own tables): the e2e suite shares
// one database and file execution order is not guaranteed, so every wipe()
// must be safe regardless of what another file left behind (same rationale
// as admin-realm.e2e-spec.ts's wipe()).
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
  await prisma.comboSlotOption.deleteMany()
  await prisma.comboSlot.deleteMany()
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

type Server = Parameters<typeof request>[0]

function errorCode(res: request.Response): string {
  return (res.body as { error: { code: string } }).error.code
}

describe('POS sessions and permissions (#169, e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let server: Server
  let tenantId: string
  let outletId: string
  const roles: Record<string, string> = {}

  async function seedTenant(name: string): Promise<{ tenantId: string; outletId: string }> {
    const id = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId: id, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id,
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
    const brand = await prisma.brand.create({ data: { tenantId: id, name } })
    const outlet = await prisma.outlet.create({ data: { tenantId: id, brandId: brand.id, name: 'Main', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' } })
    return { tenantId: id, outletId: outlet.id }
  }

  /** A staff member with an active PIN and a token issued at their current session version. */
  async function staffWithToken(roleName: string): Promise<{ id: string; token: string }> {
    const staff = await prisma.staffUser.create({
      data: { tenantId, roleId: roles[roleName], name: `${roleName} ${uuidv7().slice(-4)}`, pinHash: 'x', pinIssuedAt: new Date() },
    })
    return { id: staff.id, token: signPosToken({ id: staff.id, tenantId, outletId, name: staff.name, sessionVersion: staff.sessionVersion }) }
  }

  const menu = (token: string) => request(server).get('/pos/v1/menu').set('Authorization', `Bearer ${token}`)

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    ;({ tenantId, outletId } = await seedTenant('Sessions Co'))
    for (const name of ['Owner', 'Manager', 'Cashier', 'Waiter', 'Kitchen', 'Accountant']) {
      roles[name] = (await prisma.role.create({ data: { tenantId, name, isSystem: true, isManager: name === 'Owner' || name === 'Manager' } })).id
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    server = app.getHttpServer() as Server
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('accepts a current token', async () => {
    const { token } = await staffWithToken('Waiter')
    expect((await menu(token)).status).toBe(200)
  })

  it('refuses a token issued without a session version (every pre-#169 token)', async () => {
    const { id } = await staffWithToken('Waiter')
    const secret = process.env.POS_JWT_SECRET as string
    const legacy = jwt.sign({ tenantId, outletId, name: 'Old' }, secret, { subject: id, audience: 'pos', expiresIn: '1h' })
    const res = await menu(legacy)
    expect(res.status).toBe(401)
  })

  it('refuses the token once the session version moves on', async () => {
    const { id, token } = await staffWithToken('Cashier')
    await prisma.staffUser.update({ where: { id }, data: { sessionVersion: { increment: 1 } } })
    const res = await menu(token)
    expect(res.status).toBe(401)
    expect(errorCode(res)).toBe('session_revoked')
  })

  it('refuses the token once the PIN is revoked, even at the same version', async () => {
    const { id, token } = await staffWithToken('Cashier')
    await prisma.staffUser.update({ where: { id }, data: { pinRevokedAt: new Date() } })
    expect((await menu(token)).status).toBe(401)
  })

  it("refuses a token naming another tenant's staff member", async () => {
    const other = await seedTenant('Other Co')
    const role = await prisma.role.create({ data: { tenantId: other.tenantId, name: 'Owner', isSystem: true, isManager: true } })
    const foreign = await prisma.staffUser.create({ data: { tenantId: other.tenantId, roleId: role.id, name: 'Foreign', pinHash: 'x' } })
    const token = signPosToken({ id: foreign.id, tenantId, outletId, name: 'Foreign', sessionVersion: 0 })
    expect((await menu(token)).status).toBe(401)
  })

  it('logout ends the session', async () => {
    const { token } = await staffWithToken('Waiter')
    const out = await request(server).post('/pos/v1/auth/logout').set('Authorization', `Bearer ${token}`)
    expect(out.status).toBe(204)
    expect((await menu(token)).status).toBe(401)
  })

  it.each(['Waiter', 'Kitchen'])('%s cannot settle a bill or open a shift', async (role) => {
    const { token } = await staffWithToken(role)
    const finalize = await request(server).post(`/pos/v1/bills/${uuidv7()}/finalize`).set('Authorization', `Bearer ${token}`).send({})
    expect(finalize.status).toBe(403)
    expect(errorCode(finalize)).toBe('forbidden')
    const shift = await request(server).post('/pos/v1/shifts').set('Authorization', `Bearer ${token}`).send({ openingFloatMinor: 0 })
    expect(shift.status).toBe(403)
  })

  it('Kitchen cannot take orders; Accountant cannot fire to the kitchen', async () => {
    const kitchen = await staffWithToken('Kitchen')
    const line = await request(server).post(`/pos/v1/orders/${uuidv7()}/lines`).set('Authorization', `Bearer ${kitchen.token}`).send({})
    expect(line.status).toBe(403)
    const accountant = await staffWithToken('Accountant')
    const bump = await request(server).post(`/kitchen/v1/tickets/${uuidv7()}/bump`).set('Authorization', `Bearer ${accountant.token}`)
    expect(bump.status).toBe(403)
  })

  it.each(['Cashier', 'Manager', 'Owner', 'Accountant'])('%s gets past the permission check on settlement', async (role) => {
    const { token } = await staffWithToken(role)
    const res = await request(server).post(`/pos/v1/bills/${uuidv7()}/finalize`).set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  it("the owner's role change and PIN revoke end open sessions", async () => {
    const owner = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@sessions.example' })
    const cashier = await staffWithToken('Cashier')
    const patch = await request(server)
      .patch(`/admin/v1/staff/${cashier.id}`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ roleId: roles.Waiter, reason: 'Moved to the floor' })
    expect(patch.status).toBe(200)
    expect((await menu(cashier.token)).status).toBe(401)

    const waiter = await staffWithToken('Waiter')
    const revoke = await request(server).post(`/admin/v1/staff/${waiter.id}/revoke-pin`).set('Authorization', `Bearer ${owner}`).send({ reason: 'Left' })
    expect(revoke.status).toBe(200)
    expect((await menu(waiter.token)).status).toBe(401)
  })

  it('the owner sees each role\'s permissions', async () => {
    const owner = signAdminToken({ id: uuidv7(), tenantId, email: 'owner@sessions.example' })
    const res = await request(server).get('/admin/v1/roles').set('Authorization', `Bearer ${owner}`)
    const waiter = (res.body as { name: string; permissions: string[] }[]).find((r) => r.name === 'Waiter')
    expect(waiter?.permissions).toEqual(['take_orders', 'fire_kitchen'])
  })
})
