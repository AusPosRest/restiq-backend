// Issue #118: owner password login. Covers the returning-owner counterpart
// to CAP-1's accept-invite (which already signs an owner in as part of
// setting a password) - same-shape 401 for unknown email vs. wrong
// password (no user enumeration), lockout after 5 failures, and that a
// login-issued token is scoped to its own tenant only.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { createHash, randomBytes } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { setLockoutMsForTesting } from '../src/admin'
import { uuidv7 } from '../src/platform'

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

describe('/admin/v1/auth/login (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  const PASSWORD = 'a-real-owner-password-1'

  async function createTenant(name: string): Promise<string> {
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
        status: 'provisioning',
        plan: 'standard',
        billingPeriod: 'monthly',
      },
    })
    return tenantId
  }

  // Creates the owner through the real accept-invite endpoint, same as
  // tenant-onboarding does - not a direct prisma write, so login exercises
  // an owner row shaped exactly like production ones (argon2 hash included).
  async function createOwnerViaInvite(tenantId: string, email: string, password: string): Promise<void> {
    const token = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await prisma.ownerInvite.create({
      data: {
        tenantId,
        email,
        firstName: 'Test',
        lastName: 'Owner',
        tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    const res = await request(httpServer).post('/admin/v1/auth/accept-invite').send({ token, password })
    expect(res.status).toBe(200)
  }

  let tenantAId: string
  let tenantBId: string
  const ownerAEmail = 'owner-a@admin-auth-test.example'
  const ownerBEmail = 'owner-b@admin-auth-test.example'

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]

    tenantAId = await createTenant('Login Test Co A')
    tenantBId = await createTenant('Login Test Co B')
    await createOwnerViaInvite(tenantAId, ownerAEmail, PASSWORD)
    await createOwnerViaInvite(tenantBId, ownerBEmail, PASSWORD)

    // Distinct branding per tenant so a cross-tenant read would show up.
    await prisma.tenant.update({ where: { id: tenantAId }, data: { brandingTokens: { receiptFooter: 'Tenant A footer' } } })
    await prisma.tenant.update({ where: { id: tenantBId }, data: { brandingTokens: { receiptFooter: 'Tenant B footer' } } })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('logs in and the returned token authorizes only this owner\'s tenant', async () => {
    const res = await request(httpServer).post('/admin/v1/auth/login').send({ email: ownerAEmail, password: PASSWORD })
    expect(res.status).toBe(200)
    const body = res.body as { token: string; owner: { tenantId: string; email: string } }
    expect(body.owner.tenantId).toBe(tenantAId)
    expect(body.owner.email).toBe(ownerAEmail)

    const branding = await request(httpServer).get('/admin/v1/branding').set('Authorization', `Bearer ${body.token}`)
    expect(branding.status).toBe(200)
    // Proves the token is scoped to tenant A, never tenant B - the branding
    // read has no tenant-id input except what the login-issued token carries.
    expect((branding.body as { receiptFooter: string }).receiptFooter).toBe('Tenant A footer')
    expect((branding.body as { receiptFooter: string }).receiptFooter).not.toBe('Tenant B footer')
  })

  it('rejects a wrong password with the same generic 401 body as an unknown email', async () => {
    const wrongPassword = await request(httpServer)
      .post('/admin/v1/auth/login')
      .send({ email: ownerAEmail, password: 'not-the-right-password' })
    expect(wrongPassword.status).toBe(401)

    const unknownEmail = await request(httpServer)
      .post('/admin/v1/auth/login')
      .send({ email: 'nobody@admin-auth-test.example', password: 'whatever-password' })
    expect(unknownEmail.status).toBe(401)

    expect(wrongPassword.body).toEqual(unknownEmail.body)
    expect((wrongPassword.body as { error: { code: string } }).error.code).toBe('invalid_credentials')
  })

  it('locks out after 5 failed attempts and 429s the 6th, even with the correct password', async () => {
    const email = 'lockout-owner@admin-auth-test.example'
    await createOwnerViaInvite(tenantAId, email, PASSWORD)

    for (let i = 0; i < 5; i++) {
      const res = await request(httpServer).post('/admin/v1/auth/login').send({ email, password: 'wrong-password' })
      expect(res.status).toBe(401)
    }

    const locked = await request(httpServer).post('/admin/v1/auth/login').send({ email, password: PASSWORD })
    expect(locked.status).toBe(429)
    expect((locked.body as { error: { code: string } }).error.code).toBe('locked_out')
  })

  it('clears the lockout once the window expires', async () => {
    setLockoutMsForTesting(50)
    const email = 'lockout-recovery-owner@admin-auth-test.example'
    await createOwnerViaInvite(tenantAId, email, PASSWORD)

    for (let i = 0; i < 5; i++) {
      await request(httpServer).post('/admin/v1/auth/login').send({ email, password: 'wrong-password' })
    }
    expect((await request(httpServer).post('/admin/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(429)

    await new Promise((resolve) => setTimeout(resolve, 75))

    const res = await request(httpServer).post('/admin/v1/auth/login').send({ email, password: PASSWORD })
    expect(res.status).toBe(200)
    setLockoutMsForTesting(30_000)
  })
})
