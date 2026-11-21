// #314 service mode: an operator opens one restaurant's owner console for support. Ops mints a 60 s
// handoff code; the web server redeems it at the restaurant's own address for a 1 h admin-realm token
// that is bound to that restaurant, ends with the operator's own session, and cannot do owner-only things.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signAdminToken, signOpsToken, uuidv7 } from '../src/platform'

const OPERATOR_EMAIL = 'service-operator@restiq.example'
const OTHER_OPERATOR_EMAIL = 'service-operator-2@restiq.example'
const SECRET = 'b'.repeat(40)
const BASE = 'idelta.com.au'

interface ErrorBody {
  error: { code: string; message: string }
}
interface Minted {
  code: string
  slug: string | null
  expiresInSeconds: number
}
interface Redeemed {
  token: string
  expiresInSeconds: number
}

let gstinCounter = 0
function payload(companyName: string, slug: string) {
  const gstin = `29SVCDE${String(2000 + gstinCounter++).padStart(4, '0')}F1Z5`
  return {
    business: { companyName, registeredAddress: '12 MG Road, Bengaluru', contactName: 'Arjun', contactEmail: 'arjun@service.example', contactPhone: '+91 98765 43210' },
    tax: { country: 'IN', registrationNumber: gstin, legalEntityName: `${companyName} Pvt Ltd`, taxProfile: 'India GST - CGST/SGST split' },
    brandsOutlets: { brandName: companyName, outlets: [{ name: 'Main', address: '1 Road', type: 'dine_in', timezone: 'Asia/Kolkata' }] },
    subscription: { plan: 'standard', billingPeriod: 'monthly' },
    ownerInvite: { email: `owner-${gstin}@service.example`, firstName: 'Arjun', lastName: 'Mehta' },
    slug,
  }
}

describe('service mode (e2e, #314)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let ops: string
  let operatorIds: string[] = []
  const createdTenants: string[] = []
  const stamp = Date.now().toString(36)
  const slugA = `svc-a-${stamp}`
  const slugB = `svc-b-${stamp}`
  let tenantA = ''
  let tenantB = ''

  beforeAll(async () => {
    process.env.PROXY_SHARED_SECRET = SECRET
    process.env.BASE_DOMAIN = BASE
    prisma = createPrismaClient()
    await prisma.operatorUser.deleteMany({ where: { email: { in: [OPERATOR_EMAIL, OTHER_OPERATOR_EMAIL] } } })
    const operator = await prisma.operatorUser.create({ data: { email: OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    const other = await prisma.operatorUser.create({ data: { email: OTHER_OPERATOR_EMAIL, passwordHash: await argon2.hash('irrelevant-here') } })
    operatorIds = [operator.id, other.id]
    ops = signOpsToken({ id: operator.id, email: operator.email, sessionVersion: operator.sessionVersion })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]

    for (const [name, slug] of [['Service A', slugA], ['Service B', slugB]] as const) {
      const res = await request(httpServer).post('/ops/v1/tenants').set('Authorization', `Bearer ${ops}`).send(payload(name, slug))
      expect(res.status).toBe(201)
      createdTenants.push((res.body as { tenant: { id: string } }).tenant.id)
    }
    tenantA = createdTenants[0]
    tenantB = createdTenants[1]
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
    await prisma.controlPlaneAuditEvent.deleteMany({ where: { actorId: { in: operatorIds } } })
    await prisma.operatorUser.deleteMany({ where: { id: { in: operatorIds } } })
    await app.close()
    await prisma.$disconnect()
    delete process.env.PROXY_SHARED_SECRET
    delete process.env.BASE_DOMAIN
  })

  const mint = (tenantId: string, body: object = { reason: 'Owner asked for help with the menu' }, token = ops) =>
    request(httpServer).post(`/ops/v1/tenants/${tenantId}/service-session`).set('Authorization', `Bearer ${token}`).send(body)
  const redeem = (code: string, slug?: string) => {
    const req = request(httpServer).post('/admin/v1/auth/service-session').send({ code })
    return slug ? req.set('x-restiq-tenant-host', `${slug}.${BASE}`).set('x-restiq-proxy-secret', SECRET) : req
  }
  const admin = (method: 'get' | 'post' | 'put', path: string, token: string, slug?: string) => {
    const req = request(httpServer)[method](path).set('Authorization', `Bearer ${token}`)
    return slug ? req.set('x-restiq-tenant-host', `${slug}.${BASE}`).set('x-restiq-proxy-secret', SECRET) : req
  }
  async function serviceToken(tenantId = tenantA, slug = slugA, opsToken = ops): Promise<string> {
    const minted = await mint(tenantId, undefined, opsToken).expect(200)
    return ((await redeem((minted.body as Minted).code, slug).expect(200)).body as Redeemed).token
  }

  it('mints a code only with a reason, and audits it on both planes', async () => {
    expect(((await mint(tenantA, {}).expect(400)).body as ErrorBody).error.code).toBeDefined()
    expect((await mint(tenantA, { reason: '' })).status).toBe(400)
    await request(httpServer).post(`/ops/v1/tenants/${tenantA}/service-session`).send({ reason: 'x' }).expect(401)

    const res = await mint(tenantA).expect(200)
    const body = res.body as Minted
    expect(body).toEqual({ code: expect.any(String) as string, slug: slugA, expiresInSeconds: 60 })

    const tenantRow = await prisma.auditEvent.findFirst({ where: { tenantId: tenantA, action: 'tenant.service_session_started' } })
    expect(tenantRow).toMatchObject({ actorId: operatorIds[0], actorEmail: OPERATOR_EMAIL, reason: 'Owner asked for help with the menu' })
    const controlRow = await prisma.controlPlaneAuditEvent.findFirst({ where: { actorId: operatorIds[0], action: 'tenant.service_session_started' } })
    expect(controlRow?.actorEmail).toBe(OPERATOR_EMAIL)
  })

  it('refuses to mint for an unknown, deleted or inactive tenant', async () => {
    expect(((await mint(uuidv7()).expect(404)).body as ErrorBody).error.code).toBe('not_found')

    await prisma.tenant.update({ where: { id: tenantB }, data: { status: 'inactive' } })
    expect(((await mint(tenantB).expect(409)).body as ErrorBody).error.code).toBe('tenant_inactive')
    await prisma.tenant.update({ where: { id: tenantB }, data: { status: 'provisioning', deletedAt: new Date() } })
    expect(((await mint(tenantB).expect(404)).body as ErrorBody).error.code).toBe('not_found')
    await prisma.tenant.update({ where: { id: tenantB }, data: { deletedAt: null } })
  })

  it('redeems a code at the restaurant address for a 1 h token that reads its tenant, with service filled', async () => {
    const code = ((await mint(tenantA).expect(200)).body as Minted).code
    const res = await redeem(code, slugA).expect(200)
    const body = res.body as Redeemed
    expect(body).toEqual({ token: expect.any(String) as string, expiresInSeconds: 3600 })

    const tenant = await admin('get', '/admin/v1/tenant', body.token, slugA).expect(200)
    const service = (tenant.body as { service: { operatorEmail: string; expiresAt: string } }).service
    expect(service.operatorEmail).toBe(OPERATOR_EMAIL)
    const left = new Date(service.expiresAt).getTime() - Date.now()
    expect(left).toBeGreaterThan(3500 * 1000)
    expect(left).toBeLessThanOrEqual(3600 * 1000)
  })

  it('binds the code and the token to that restaurant address', async () => {
    const code = ((await mint(tenantA).expect(200)).body as Minted).code
    expect(((await redeem(code, slugB).expect(403)).body as ErrorBody).error.code).toBe('tenant_mismatch')

    const token = await serviceToken()
    expect(((await admin('get', '/admin/v1/tenant', token, slugB).expect(403)).body as ErrorBody).error.code).toBe('tenant_mismatch')
  })

  it('refuses an expired, tampered or wrong-audience code, and never takes a code as a session', async () => {
    const secret = process.env.ADMIN_JWT_SECRET as string
    const expired = jwt.sign({ tenantId: tenantA, email: OPERATOR_EMAIL, exp: Math.floor(Date.now() / 1000) - 10 }, secret, { subject: operatorIds[0], audience: 'admin-handoff' })
    expect(((await redeem(expired, slugA).expect(401)).body as ErrorBody).error.code).toBe('handoff_invalid')

    const code = ((await mint(tenantA).expect(200)).body as Minted).code
    const [head, claims, signature] = code.split('.')
    const forged = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(claims, 'base64url').toString()) as object), tenantId: tenantB })).toString('base64url')
    expect(((await redeem(`${head}.${forged}.${signature}`, slugB).expect(401)).body as ErrorBody).error.code).toBe('handoff_invalid')

    const ownerToken = signAdminToken({ id: uuidv7(), tenantId: tenantA, email: 'owner@a.example' })
    expect(((await redeem(ownerToken, slugA).expect(401)).body as ErrorBody).error.code).toBe('handoff_invalid')
    expect(((await admin('get', '/admin/v1/tenant', code, slugA).expect(401)).body as ErrorBody).error.code).toBe('unauthorized')
    await request(httpServer).post('/admin/v1/auth/service-session').send({ code: '' }).expect(400)
    await request(httpServer).post('/admin/v1/auth/service-session').send({ code: 'x'.repeat(2049) }).expect(400)
  })

  it('refuses the owner-only routes in service mode, but not to the owner', async () => {
    const token = await serviceToken()
    for (const [method, path] of [['post', `/admin/v1/agreement/${uuidv7()}/sign`], ['post', '/admin/v1/reader-orders'], ['post', '/admin/v1/auth/logout']] as const) {
      const res = await admin(method, path, token, slugA).send({})
      expect(res.status, path).toBe(403)
      expect((res.body as ErrorBody).error, path).toEqual({ code: 'service_mode_forbidden', message: 'Only the owner can do this' })
    }

    const owner = await prisma.ownerUser.create({ data: { tenantId: tenantA, email: `owner-${stamp}@service.example`, firstName: 'O', lastName: 'Wner', passwordHash: 'x' } })
    const ownerToken = signAdminToken({ id: owner.id, tenantId: tenantA, email: owner.email, sessionVersion: owner.sessionVersion })
    const tenant = await admin('get', '/admin/v1/tenant', ownerToken, slugA).expect(200)
    expect((tenant.body as { service: unknown }).service).toBeNull()
    await admin('post', '/admin/v1/auth/logout', ownerToken, slugA).expect(204)
  })

  it('audits work done in service mode as the operator', async () => {
    const token = await serviceToken()
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId: tenantA, name: 'Cashier' } })
    const staff = await prisma.staffUser.create({ data: { tenantId: tenantA, roleId: role.id, name: 'Asha', pinHash: 'x', pinIssuedAt: new Date() } })
    await admin('post', `/admin/v1/staff/${staff.id}/revoke-pin`, token, slugA).send({ reason: 'Lost tablet' }).expect(200)
    const row = await prisma.auditEvent.findFirst({ where: { tenantId: tenantA, action: 'staff.pin_revoked' } })
    expect(row).toMatchObject({ actorId: operatorIds[0], actorEmail: OPERATOR_EMAIL })
  })

  it('ends the service session when the operator logs out', async () => {
    const other = await prisma.operatorUser.findUniqueOrThrow({ where: { id: operatorIds[1] } })
    const otherOps = signOpsToken({ id: other.id, email: other.email, sessionVersion: other.sessionVersion })
    const token = await serviceToken(tenantA, slugA, otherOps)
    await admin('get', '/admin/v1/tenant', token, slugA).expect(200)

    // A code minted before the logout is refused too.
    const code = ((await mint(tenantA, undefined, otherOps).expect(200)).body as Minted).code
    await request(httpServer).post('/ops/v1/auth/logout').set('Authorization', `Bearer ${otherOps}`).expect(204)
    expect(((await admin('get', '/admin/v1/tenant', token, slugA).expect(401)).body as ErrorBody).error.code).toBe('session_revoked')
    expect(((await redeem(code, slugA).expect(401)).body as ErrorBody).error.code).toBe('session_revoked')
  })

  it('stops serving a service token once the tenant is deactivated', async () => {
    const token = await serviceToken()
    const code = ((await mint(tenantA).expect(200)).body as Minted).code
    await prisma.tenant.update({ where: { id: tenantA }, data: { status: 'inactive' } })
    expect(((await admin('get', '/admin/v1/tenant', token, slugA).expect(403)).body as ErrorBody).error.code).toBe('tenant_inactive')
    expect(((await redeem(code, slugA).expect(403)).body as ErrorBody).error.code).toBe('tenant_inactive')
    await prisma.tenant.update({ where: { id: tenantA }, data: { status: 'provisioning' } })
  })
})
