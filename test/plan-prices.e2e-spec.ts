// #201: operators read and change plan list prices per country; each change is audited.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signOpsToken } from '../src/platform'

const OPERATOR_EMAIL = 'plan-prices-operator@restiq.example'

interface PlanPrice {
  country: string
  plan: string
  monthlyPriceMinor: number | null
  annualDiscountPercent: number
  currency: string
}

describe('/ops/v1/plan-prices (e2e)', () => {
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

  afterAll(async () => {
    // Put the seeded list prices back for any other file that reads them.
    await prisma.planPrice.update({ where: { country_plan: { country: 'IN', plan: 'standard' } }, data: { monthlyPriceMinor: 49900, annualDiscountPercent: 20 } })
    await app.close()
    await prisma.$disconnect()
  })

  it('lists the seeded prices per country and plan', async () => {
    const res = await request(httpServer).get('/ops/v1/plan-prices').set('Authorization', `Bearer ${opsToken}`)
    expect(res.status).toBe(200)
    const prices = (res.body as { prices: PlanPrice[] }).prices
    expect(prices.find((p) => p.country === 'IN' && p.plan === 'enterprise')).toMatchObject({ monthlyPriceMinor: 99900, annualDiscountPercent: 20, currency: 'INR' })
    expect(prices.find((p) => p.country === 'AU' && p.plan === 'standard')).toMatchObject({ monthlyPriceMinor: 4900, currency: 'AUD' })
  })

  it('changes a price with a reason, audited; null means on quote', async () => {
    const put = (body: object) => request(httpServer).put('/ops/v1/plan-prices/IN/standard').set('Authorization', `Bearer ${opsToken}`).send(body)

    const res = await put({ monthlyPriceMinor: 59900, annualDiscountPercent: 15, reason: 'Diwali pricing' })
    expect(res.status).toBe(200)
    expect((res.body as { price: PlanPrice }).price).toMatchObject({ monthlyPriceMinor: 59900, annualDiscountPercent: 15 })
    const audit = await prisma.controlPlaneAuditEvent.findFirst({ where: { action: 'plan_price.updated' }, orderBy: { occurredAt: 'desc' } })
    expect(audit?.reason).toContain('Diwali pricing')

    expect((await put({ monthlyPriceMinor: null, annualDiscountPercent: 20, reason: 'Quote only' })).body).toMatchObject({ price: { monthlyPriceMinor: null } })
    expect((await put({ monthlyPriceMinor: -1, annualDiscountPercent: 20, reason: 'x' })).status).toBe(400)
    expect((await put({ monthlyPriceMinor: 100, annualDiscountPercent: 20 })).status).toBe(400)
    expect((await request(httpServer).put('/ops/v1/plan-prices/US/standard').set('Authorization', `Bearer ${opsToken}`).send({ monthlyPriceMinor: 1, annualDiscountPercent: 0, reason: 'x' })).status).toBe(400)
  })

  it('is for operators only', async () => {
    expect((await request(httpServer).get('/ops/v1/plan-prices')).status).toBe(401)
  })
})
