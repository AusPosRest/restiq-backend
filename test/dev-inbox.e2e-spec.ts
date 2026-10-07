// #198: the mail simulator keeps outgoing email for the dev inbox, which is closed unless the simulator is on.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { MailService } from '../src/platform'

describe('/dev/v1/inbox (e2e)', () => {
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

  afterEach(() => vi.unstubAllEnvs())

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('is closed unless the mail simulator is the provider', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'log')
    expect((await request(httpServer).get('/dev/v1/inbox')).status).toBe(404)
  })

  it('stores sent mail and lists it newest first, filtered by address', async () => {
    vi.stubEnv('MAIL_PROVIDER', 'simulator')
    await prisma.simulatedMessage.deleteMany({ where: { to: { in: ['anita@bayleaf.example', 'ravi@binflow.example'] } } })
    const mail = app.get(MailService)
    await mail.send({ to: 'anita@bayleaf.example', subject: 'First', text: 'one' })
    await mail.send({ to: 'Anita@Bayleaf.example', subject: 'Second', text: 'two' })
    await mail.send({ to: 'ravi@binflow.example', subject: 'Other', text: 'three' })

    const res = await request(httpServer).get('/dev/v1/inbox').query({ to: 'anita@bayleaf.example' })
    expect(res.status).toBe(200)
    const { messages } = res.body as { messages: { to: string; subject: string; sentAt: string }[] }
    expect(messages.map((m) => m.subject)).toEqual(['Second', 'First'])
  })
})
