// #198: the mail simulator keeps outgoing email for the dev inbox, which is closed unless the simulator is on.
// restiq-backend#203: also behind the operator login - the global OpsAuthGuard covers /ops/*.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { MailService, signOpsToken } from '../src/platform'

const OPERATOR_EMAIL = 'dev-inbox-operator@restiq.example'

describe('/ops/v1/dev-inbox (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let opsToken: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await prisma.operatorUser.deleteMany({ where: { email: OPERATOR_EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    opsToken = signOpsToken({ id: operator.id, email: operator.email })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterEach(() => vi.unstubAllEnvs())

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('refuses a request without an operator session, even with the simulator on', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'simulator')
    expect((await request(httpServer).get('/ops/v1/dev-inbox')).status).toBe(401)
  })

  it('is closed unless the mail simulator is the provider', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'log')
    expect((await request(httpServer).get('/ops/v1/dev-inbox').set('Authorization', `Bearer ${opsToken}`)).status).toBe(404)
  })

  it('stores sent mail and lists it newest first, filtered by address', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'simulator')
    // Case-insensitive: 'Anita@Bayleaf.example' below must be cleared too, or reruns on one DB pile up.
    await prisma.simulatedMessage.deleteMany({ where: { OR: ['anita@bayleaf.example', 'ravi@binflow.example'].map((to) => ({ to: { equals: to, mode: 'insensitive' as const } })) } })
    const mail = app.get(MailService)
    await mail.send({ to: 'anita@bayleaf.example', subject: 'First', text: 'one' })
    await mail.send({ to: 'Anita@Bayleaf.example', subject: 'Second', text: 'two' })
    await mail.send({ to: 'ravi@binflow.example', subject: 'Other', text: 'three' })

    const res = await request(httpServer).get('/ops/v1/dev-inbox').query({ to: 'anita@bayleaf.example' }).set('Authorization', `Bearer ${opsToken}`)
    expect(res.status).toBe(200)
    const { messages } = res.body as { messages: { to: string; subject: string; sentAt: string }[] }
    expect(messages.map((m) => m.subject)).toEqual(['Second', 'First'])
  })
})
