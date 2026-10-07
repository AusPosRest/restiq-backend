// D14: every tenant has its own subdomain. Ops picks it (or gets one made from the company name) when
// the tenant is created; the sign-in pages find the tenant from the address; and when our web server
// forwards the address, a token for another tenant is refused.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signGuestToken, signOpsToken, signPosToken, uuidv7 } from '../src/platform'

const OPERATOR_EMAIL = 'address-operator@restiq.example'
const SECRET = 'a'.repeat(40)
const BASE = 'idelta.com.au'

interface ErrorBody {
  error: { code: string; message: string }
}

let gstinCounter = 0
function payload(companyName: string, slug?: string) {
  // Valid-looking, distinct GSTINs: the tax number is unique across tenants.
  const gstin = `29ABCDE${String(1000 + gstinCounter++).padStart(4, '0')}F1Z5`
  return {
    business: { companyName, registeredAddress: '12 MG Road, Bengaluru', contactName: 'Arjun', contactEmail: 'arjun@address.example', contactPhone: '+91 98765 43210' },
    tax: { country: 'IN', registrationNumber: gstin, legalEntityName: `${companyName} Pvt Ltd`, taxProfile: 'India GST - CGST/SGST split' },
    brandsOutlets: { brandName: companyName, outlets: [{ name: 'Main', address: '1 Road', type: 'dine_in', timezone: 'Asia/Kolkata' }] },
    subscription: { plan: 'standard', billingPeriod: 'monthly' },
    ownerInvite: { email: `owner-${gstin}@address.example`, firstName: 'Arjun', lastName: 'Mehta' },
    ...(slug === undefined ? {} : { slug }),
  }
}

describe('tenant subdomain addressing (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let ops: string
  const createdTenants: string[] = []
  const stamp = Date.now().toString(36)

  beforeAll(async () => {
    process.env.PROXY_SHARED_SECRET = SECRET
    process.env.BASE_DOMAIN = BASE
    prisma = createPrismaClient()
    await prisma.operatorUser.deleteMany({ where: { email: OPERATOR_EMAIL } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    ops = signOpsToken({ id: operator.id, email: operator.email })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    for (const id of createdTenants) {
      await prisma.auditEvent.deleteMany({ where: { tenantId: id } })
      await prisma.staffUser.deleteMany({ where: { tenantId: id } })
      await prisma.role.deleteMany({ where: { tenantId: id } })
      await prisma.itemPrice.deleteMany({ where: { tenantId: id } })
      await prisma.menuItem.deleteMany({ where: { tenantId: id } })
      await prisma.menuCategory.deleteMany({ where: { tenantId: id } })
      await prisma.station.deleteMany({ where: { tenantId: id } })
      await prisma.diningTable.deleteMany({ where: { tenantId: id } })
      await prisma.floor.deleteMany({ where: { tenantId: id } })
      await prisma.outletCapability.deleteMany({ where: { tenantId: id } })
      await prisma.outlet.deleteMany({ where: { tenantId: id } })
      await prisma.brand.deleteMany({ where: { tenantId: id } })
      await prisma.ownerInvite.deleteMany({ where: { tenantId: id } })
      await prisma.ownerUser.deleteMany({ where: { tenantId: id } })
      await prisma.tenantTaxRegistration.deleteMany({ where: { tenantId: id } })
      await prisma.tenant.deleteMany({ where: { id } })
      await prisma.tenantRegistryEntry.deleteMany({ where: { tenantId: id } })
    }
    await prisma.onboardingDraft.deleteMany()
    await app.close()
    await prisma.$disconnect()
    delete process.env.PROXY_SHARED_SECRET
    delete process.env.BASE_DOMAIN
  })

  const authed = (req: request.Test, token = ops) => req.set('Authorization', `Bearer ${token}`)
  async function create(companyName: string, slug?: string) {
    const res = await authed(request(httpServer).post('/ops/v1/tenants')).send(payload(companyName, slug))
    if (res.status === 201) createdTenants.push((res.body as { tenant: { id: string } }).tenant.id)
    return res
  }

  it('checks a subdomain: free, taken, reserved or badly formed', async () => {
    const free = await authed(request(httpServer).get(`/ops/v1/tenant-slugs/free-${stamp}`)).expect(200)
    expect(free.body).toEqual({ slug: `free-${stamp}`, available: true, reason: null })
    expect((await authed(request(httpServer).get('/ops/v1/tenant-slugs/api')).expect(200)).body).toMatchObject({ available: false, reason: 'reserved' })
    expect((await authed(request(httpServer).get('/ops/v1/tenant-slugs/Bad_Name')).expect(200)).body).toMatchObject({ available: false, reason: 'invalid' })

    await create('Taken Kitchen', `taken-${stamp}`).then((res) => expect(res.status).toBe(201))
    expect((await authed(request(httpServer).get(`/ops/v1/tenant-slugs/TAKEN-${stamp}`)).expect(200)).body).toMatchObject({ available: false, reason: 'taken' })
    await request(httpServer).get('/ops/v1/tenant-slugs/anything').expect(401)
  })

  it('creates a tenant with the subdomain asked for, or one made from the company name, and refuses a bad or clashing one', async () => {
    const chosen = await create('Chosen Name Ltd', `chosen-${stamp}`)
    expect(chosen.status).toBe(201)
    expect((chosen.body as { tenant: { slug: string } }).tenant.slug).toBe(`chosen-${stamp}`)

    const first = await create(`Derived Bistro ${stamp} Pvt Ltd`)
    const second = await create(`Derived Bistro ${stamp} Pvt Ltd`)
    expect((first.body as { tenant: { slug: string } }).tenant.slug).toBe(`derived-bistro-${stamp}`)
    expect((second.body as { tenant: { slug: string } }).tenant.slug).toBe(`derived-bistro-${stamp}-2`)

    expect(((await create('Clash Co', `chosen-${stamp}`)).body as ErrorBody).error.code).toBe('slug_taken')
    expect(((await create('Reserved Co', 'admin')).body as ErrorBody).error.code).toBe('slug_reserved')
    expect(((await create('Short Co', 'a')).body as ErrorBody).error.code).toBe('slug_invalid')
    expect(await prisma.tenant.count({ where: { name: { in: ['Clash Co', 'Reserved Co', 'Short Co'] } } })).toBe(0)
  })

  it('finds the tenant for an address under the base domain, and 404s anything else', async () => {
    await create('Lookup Cafe', `lookup-${stamp}`).then((res) => expect(res.status).toBe(201))
    const found = await request(httpServer).get('/public/v1/tenant').query({ host: `lookup-${stamp}.${BASE}` }).expect(200)
    expect(found.body).toMatchObject({ slug: `lookup-${stamp}`, displayName: 'Lookup Cafe', status: 'provisioning', country: 'IN', currency: 'INR', branding: {} })
    expect(JSON.stringify(found.body)).not.toMatch(/registeredAddress|contactEmail|contactPhone/)
    // The Host header works too, with a port.
    await request(httpServer).get('/public/v1/tenant').set('Host', `Lookup-${stamp}.${BASE}:443`).expect(200)

    for (const host of [`nobody-${stamp}.${BASE}`, BASE, `lookup-${stamp}.example.com`, `a.b.${BASE}`, '']) {
      const res = await request(httpServer).get('/public/v1/tenant').query({ host }).expect(404)
      expect((res.body as ErrorBody).error.code).toBe('tenant_not_found')
    }
  })

  it('refuses a token for another tenant when the address is forwarded, and only then', async () => {
    const [a, b] = [`mism-a-${stamp}`, `mism-b-${stamp}`]
    const tenantA = (await create('Mismatch A', a)).body as { tenant: { id: string } }
    const tenantB = (await create('Mismatch B', b)).body as { tenant: { id: string } }
    const outletA = (await prisma.outlet.findFirstOrThrow({ where: { tenantId: tenantA.tenant.id } })).id
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId: tenantA.tenant.id, name: 'Cashier' } })
    const staff = await prisma.staffUser.create({ data: { tenantId: tenantA.tenant.id, roleId: role.id, name: 'Asha' } })
    const tokens = {
      admin: signAdminToken({ id: uuidv7(), tenantId: tenantA.tenant.id, email: 'owner@a.example' }),
      pos: signPosToken({ sessionVersion: 0, id: staff.id, tenantId: tenantA.tenant.id, outletId: outletA, name: 'Asha' }),
      guest: signGuestToken({ id: uuidv7(), sessionId: uuidv7(), tenantId: tenantA.tenant.id, outletId: outletA, tableId: null, name: 'Guest' }),
    }
    const routes = { admin: '/admin/v1/outlets', pos: `/pos/v1/outlets/${outletA}/table-map`, guest: '/guest/v1/session' } as const
    const call = (realm: keyof typeof routes, host?: string, secret: string | undefined = SECRET) => {
      let req = request(httpServer).get(routes[realm]).set('Authorization', `Bearer ${tokens[realm]}`)
      if (host) req = req.set('x-restiq-tenant-host', host)
      if (secret) req = req.set('x-restiq-proxy-secret', secret)
      return req
    }

    for (const realm of ['admin', 'pos', 'guest'] as const) {
      const wrong = await call(realm, `${b}.${BASE}`)
      expect(wrong.status, realm).toBe(403)
      expect((wrong.body as ErrorBody).error.code, realm).toBe('tenant_mismatch')
      expect((await call(realm, `${a}.${BASE}`)).status, `${realm} own address`).not.toBe(403)
      // No address forwarded, an unproven one, or an address outside the base domain: no check.
      expect((await call(realm)).status, `${realm} no address`).not.toBe(403)
      expect((await call(realm, `${b}.${BASE}`, 'z'.repeat(40))).status, `${realm} wrong secret`).not.toBe(403)
      expect((await call(realm, `${b}.example.com`)).status, `${realm} other domain`).not.toBe(403)
    }
    // An address that names nobody cannot match anyone either.
    expect((await call('admin', `ghost-${stamp}.${BASE}`)).status).toBe(403)
    void tenantB
  })
})
