// CAP-1 success criterion, end to end: a tenant-role JWT presented to any
// /ops route is rejected, whichever secret signed it (AD-3).
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'

const EMAIL = 'operator@restiq.example'
const PASSWORD = 'correct-horse-battery'
// Stands in for the (future) tenant realm's signing key - the point is that
// it is a different secret than OPS_JWT_SECRET.
const TENANT_SECRET = 'a-different-tenant-secret'

describe('/ops realm separation (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]

  beforeAll(async () => {
    prisma = createPrismaClient()
    await prisma.controlPlaneAuditEvent.deleteMany()
    await prisma.operatorUser.deleteMany()
    await prisma.operatorUser.create({
      data: { email: EMAIL, passwordHash: await argon2.hash(PASSWORD) },
    })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  function opsSecret(): string {
    const secret = process.env.OPS_JWT_SECRET
    if (!secret) throw new Error('OPS_JWT_SECRET missing in e2e env')
    return secret
  }

  async function loginToken(): Promise<string> {
    const res = await request(httpServer).post('/ops/v1/auth/login').send({ email: EMAIL, password: PASSWORD })
    expect(res.status).toBe(200)
    return (res.body as { token: string }).token
  }

  it('signs in an operator with valid credentials and audits it', async () => {
    const res = await request(httpServer).post('/ops/v1/auth/login').send({ email: EMAIL, password: PASSWORD })
    expect(res.status).toBe(200)
    const body = res.body as { token: string; operator: { id: string; email: string } }
    expect(body.operator.email).toBe(EMAIL)
    expect(body.token.split('.')).toHaveLength(3)

    const audit = await prisma.controlPlaneAuditEvent.findMany({ where: { action: 'operator.login.succeeded' } })
    expect(audit.length).toBeGreaterThan(0)
    expect(audit[0]?.actorEmail).toBe(EMAIL)
  })

  it('answers wrong password and unknown email with the identical generic 401', async () => {
    const wrongPassword = await request(httpServer)
      .post('/ops/v1/auth/login')
      .send({ email: EMAIL, password: 'nope' })
    const unknownEmail = await request(httpServer)
      .post('/ops/v1/auth/login')
      .send({ email: 'nobody@restiq.example', password: PASSWORD })

    expect(wrongPassword.status).toBe(401)
    expect(unknownEmail.status).toBe(401)
    expect(wrongPassword.body).toEqual({
      error: { code: 'invalid_credentials', message: 'Incorrect email or password' },
    })
    expect(unknownEmail.body).toEqual(wrongPassword.body)
  })

  it('returns the current operator for a valid ops session', async () => {
    const token = await loginToken()
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect((res.body as { operator: { email: string } }).operator.email).toBe(EMAIL)
  })

  it('rejects /ops without a token', async () => {
    const res = await request(httpServer).get('/ops/v1/auth/session')
    expect(res.status).toBe(401)
    expect((res.body as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('rejects a tenant-audience token on /ops even when signed with the ops secret', async () => {
    const token = jwt.sign({ email: EMAIL }, opsSecret(), {
      subject: 'tenant-user-1',
      audience: 'tenant',
      expiresIn: '1h',
    })
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a tenant token signed with the tenant secret on /ops', async () => {
    const token = jwt.sign({ email: EMAIL }, TENANT_SECRET, {
      subject: 'tenant-user-1',
      audience: 'tenant',
      expiresIn: '1h',
    })
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects an ops-audience token signed with the wrong secret on /ops', async () => {
    const token = jwt.sign({ email: EMAIL }, TENANT_SECRET, {
      subject: 'forged-operator',
      audience: 'ops',
      expiresIn: '1h',
    })
    const res = await request(httpServer).get('/ops/v1/auth/session').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('logs out and audits it', async () => {
    const token = await loginToken()
    const res = await request(httpServer).post('/ops/v1/auth/logout').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(204)
    const audit = await prisma.controlPlaneAuditEvent.findMany({ where: { action: 'operator.logout' } })
    expect(audit.length).toBeGreaterThan(0)
  })

  it('leaves non-ops routes (health) untouched by the ops guard', async () => {
    const res = await request(httpServer).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', service: 'restiq-backend' })
  })
})
