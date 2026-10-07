// restiq-backend#181: an owner who forgot their password asks for an emailed link, sets a new
// password with it, and every session they had before is ended. The request never says whether
// the email is registered.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { MailMessage, MailService, signAdminToken, uuidv7 } from '../src/platform'

const PASSWORD = 'Old-password-1'
const NEW_PASSWORD = 'A-brand-new-one-2'

interface ErrorBody {
  error: { code: string; message: string }
}

describe('owner password reset (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  const sent: MailMessage[] = []
  let tenantId: string
  let ownerId: string
  let email: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ send: (message: MailMessage) => Promise.resolve(void sent.push(message)) })
      .compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ownerUser.deleteMany({ where: { tenantId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.tenantRegistryEntry.deleteMany({ where: { tenantId } })
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    sent.length = 0
    // A fresh tenant and owner per test, so a rate limit or a used link never leaks into the next.
    tenantId = uuidv7()
    email = `reset-${tenantId}@test.example`
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Reset Tenant',
        registeredAddress: '1 Test Street',
        contactName: 'Test',
        contactEmail: email,
        contactPhone: '+91 90000 00000',
        country: 'IN',
        status: 'active',
        plan: 'standard',
        billingPeriod: 'monthly',
      },
    })
    const owner = await prisma.ownerUser.create({ data: { tenantId, email, firstName: 'Anita', lastName: 'Rao', passwordHash: await argon2.hash(PASSWORD) } })
    ownerId = owner.id
  })

  const forgot = (address: string) => request(httpServer).post('/admin/v1/auth/forgot-password').send({ email: address })
  const reset = (token: string, password = NEW_PASSWORD) => request(httpServer).post('/admin/v1/auth/reset-password').send({ token, password })
  const login = (password: string) => request(httpServer).post('/admin/v1/auth/login').send({ email, password })
  const tokenFrom = (message: MailMessage | undefined) => /token=(rst_[0-9a-f]+)/.exec(message?.text ?? '')?.[1] ?? ''

  it('answers 202 the same for an unknown email, and sends nothing to it', async () => {
    const res = await forgot(`nobody-${uuidv7()}@test.example`).expect(202)
    expect(res.body).toEqual({ accepted: true })
    expect(sent).toHaveLength(0)
  })

  it('emails one link for a known owner, and the link sets a new password that works', async () => {
    const res = await forgot(email).expect(202)
    expect(res.body).toEqual({ accepted: true })
    await new Promise((resolve) => setTimeout(resolve, 20)) // the email goes out in the background
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe(email)
    expect(sent[0]?.text).toContain('/admin/reset-password?token=rst_')
    const token = tokenFrom(sent[0])

    await reset(token).expect(204)
    expect((await login(PASSWORD)).status).toBe(401)
    expect((await login(NEW_PASSWORD)).status).toBe(200)
    const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'owner.password_reset' } })
    expect(audit?.actorEmail).toBe(email)
  })

  it('stores only a hash of the link, and a link works once', async () => {
    await forgot(email).expect(202)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const token = tokenFrom(sent[0])
    const rows = await prisma.ownerPasswordReset.findMany({ where: { ownerId } })
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(token)

    await reset(token).expect(204)
    const again = await reset(token, 'Another-pass-3').expect(400)
    expect((again.body as ErrorBody).error.code).toBe('reset_invalid')
    expect((await login(NEW_PASSWORD)).status).toBe(200)
  })

  it('ends every session the owner had: an old token is refused, a new login works', async () => {
    const session = (await login(PASSWORD).expect(200)).body as { token: string }
    await request(httpServer).get('/admin/v1/outlets').set('Authorization', `Bearer ${session.token}`).expect(200)

    await forgot(email).expect(202)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await reset(tokenFrom(sent[0])).expect(204)

    const refused = await request(httpServer).get('/admin/v1/outlets').set('Authorization', `Bearer ${session.token}`).expect(401)
    expect((refused.body as ErrorBody).error.code).toBe('session_revoked')
    const fresh = (await login(NEW_PASSWORD).expect(200)).body as { token: string }
    await request(httpServer).get('/admin/v1/outlets').set('Authorization', `Bearer ${fresh.token}`).expect(200)
  })

  it('still accepts a token issued before sessions carried a version (it expires as before)', async () => {
    const legacy = signAdminToken({ id: ownerId, tenantId, email })
    await request(httpServer).get('/admin/v1/outlets').set('Authorization', `Bearer ${legacy}`).expect(200)
  })

  it('refuses an unknown link, an expired link and a short password', async () => {
    expect(((await reset('rst_nonsense').expect(400)).body as ErrorBody).error.code).toBe('reset_invalid')

    await forgot(email).expect(202)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const token = tokenFrom(sent[0])
    await reset(token, 'short').expect(400)
    await prisma.ownerPasswordReset.updateMany({ where: { ownerId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(((await reset(token).expect(400)).body as ErrorBody).error.code).toBe('reset_expired')
    expect((await login(PASSWORD)).status).toBe(200)
  })

  it('a newer request ends the older link', async () => {
    await forgot(email).expect(202)
    await forgot(email).expect(202)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toHaveLength(2)
    const [first, second] = [tokenFrom(sent[0]), tokenFrom(sent[1])]
    expect(((await reset(first).expect(400)).body as ErrorBody).error.code).toBe('reset_invalid')
    await reset(second).expect(204)
  })

  it('limits requests per email (3 in 15 minutes) and rejects a malformed email', async () => {
    for (let i = 0; i < 3; i++) await forgot(email).expect(202)
    await forgot(email).expect(429)
    await forgot('not-an-email').expect(400)
  })
})
