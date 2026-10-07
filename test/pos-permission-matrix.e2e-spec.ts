// Phase 1 (PROD-02): every /pos and /kitchen handler must carry a permission
// policy, and each system role may call it only if the catalogue says so. The
// route list is read from the controllers themselves, so a new route without a
// policy - or one whose policy a role should not meet - fails here instead of
// shipping open. The guard runs before any handler, so a permitted role gets
// something other than 403 (the dummy ids then answer 400/404) and a refused
// role gets 403 with code `forbidden`.
import { RequestMethod, INestApplication } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { ModulesContainer } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { IS_PUBLIC, ROLE_PERMISSIONS, ROUTE_PERMISSION, roleHasPermission, signPosToken, uuidv7 } from '../src/platform'
import type { Permission } from '../src/platform'

interface Route {
  method: string
  path: string
  policy: Permission | 'any_staff' | undefined
  where: string
}

const ROLE_REFUSAL = 'Your role cannot do this'

const VERB: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
}

function join(...parts: string[]): string {
  return '/' + parts.map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/')
}

function staffRoutes(app: INestApplication): Route[] {
  const routes: Route[] = []
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null
      if (!controller) continue
      const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined
      const base = Array.isArray(prefix) ? prefix[0] : (prefix ?? '')
      if (!/^\/?(pos|kitchen)\//.test(base)) continue
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name]
        if (typeof handler !== 'function' || name === 'constructor') continue
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined
        if (method === undefined) continue
        if (Reflect.getMetadata(IS_PUBLIC, handler) === true || Reflect.getMetadata(IS_PUBLIC, controller) === true) continue
        const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? ''
        const policy = (Reflect.getMetadata(ROUTE_PERMISSION, handler) ?? Reflect.getMetadata(ROUTE_PERMISSION, controller)) as Route['policy']
        // Route params get a well-formed dummy id so path pipes (ParseUUIDPipe) never decide the status before the guard does.
        const path = join(base, sub).replace(/:[A-Za-z]+/g, uuidv7())
        routes.push({ method: VERB[method], path, policy, where: `${controller.name}.${name}` })
      }
    }
  }
  // Logout ends the very session this test is using, so it goes last.
  return routes.sort((a, b) => Number(a.path.includes('logout')) - Number(b.path.includes('logout')))
}

function withOutlet(path: string, outletId: string): string {
  return path.replace(/\/outlets\/[0-9a-f-]{36}/, `/outlets/${outletId}`)
}

// Written by hand on purpose: the matrix below derives its expectations from each route's own
// policy, so it cannot notice a policy that was loosened. These are the money and kitchen
// actions whose policy must stay as the catalogue intends.
const INTENDED_POLICY: Readonly<Record<string, Permission>> = {
  'POST /pos/v1/bills/:id/finalize': 'settle_bills',
  'POST /pos/v1/bills/:id/refund': 'settle_bills', // then the service still demands a manager PIN
  'POST /pos/v1/bills/:id/intents': 'settle_bills',
  'POST /pos/v1/payment-intents/:id/cancel': 'settle_bills',
  'POST /pos/v1/payment-intents/:id/simulate': 'settle_bills',
  'POST /pos/v1/shifts': 'settle_bills',
  'POST /pos/v1/shifts/:id/close': 'settle_bills',
  'POST /pos/v1/shifts/:id/cash-movements': 'settle_bills',
  'POST /pos/v1/tables/:id/close-session': 'settle_bills',
  'POST /pos/v1/orders/:id/bill': 'take_orders',
  'POST /pos/v1/orders/:id/lines': 'take_orders',
  'POST /pos/v1/orders/:id/transfer': 'take_orders',
  'POST /pos/v1/outlets/:id/counter-orders': 'take_orders',
  'PATCH /pos/v1/orders/:id/status': 'fire_kitchen',
  'POST /kitchen/v1/tickets/:id/bump': 'fire_kitchen',
  'POST /kitchen/v1/tickets/:id/recall': 'fire_kitchen',
  'POST /kitchen/v1/tickets/:id/refire': 'fire_kitchen',
}

describe('POS and kitchen permission matrix (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let routes: Route[]
  const tenantId = uuidv7()
  const outletId = uuidv7()
  const tokens = new Map<string, string>()

  beforeAll(async () => {
    prisma = createPrismaClient()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
    routes = staffRoutes(app)

    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Matrix Co',
        registeredAddress: '1 Test Street',
        contactName: 'Test',
        contactEmail: 'matrix@test.example',
        contactPhone: '+91 90000 00000',
        country: 'IN',
        status: 'active',
        plan: 'standard',
        billingPeriod: 'monthly',
      },
    })
    for (const roleName of Object.keys(ROLE_PERMISSIONS)) {
      const role = await prisma.role.create({ data: { tenantId, name: roleName, isSystem: true, isManager: roleName === 'Owner' || roleName === 'Manager' } })
      const staff = await prisma.staffUser.create({ data: { tenantId, roleId: role.id, name: roleName } })
      tokens.set(roleName, signPosToken({ sessionVersion: 0, id: staff.id, tenantId, outletId, name: roleName }))
    }
  })

  afterAll(async () => {
    await prisma.staffUser.deleteMany({ where: { tenantId } })
    await prisma.role.deleteMany({ where: { tenantId } })
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.tenantRegistryEntry.deleteMany({ where: { tenantId } })
    await app.close()
    await prisma.$disconnect()
  })

  it('finds the staff routes (so the matrix below is not vacuous)', () => {
    expect(routes.length).toBeGreaterThan(40)
  })

  it('keeps the intended policy on the money and kitchen routes', () => {
    const actual = new Map(routes.map((r) => [`${r.method.toUpperCase()} ${r.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`, r.policy]))
    const drift = Object.entries(INTENDED_POLICY).filter(([key, policy]) => actual.get(key) !== policy).map(([key, policy]) => `${key}: want ${policy}, have ${String(actual.get(key))}`)
    expect(drift).toEqual([])
  })

  it('gives every staff route a permission policy', () => {
    expect(routes.filter((r) => !r.policy).map((r) => `${r.method.toUpperCase()} ${r.path} (${r.where})`)).toEqual([])
  })

  it('refuses a request with no session on every staff route', async () => {
    const wrong: string[] = []
    for (const route of routes) {
      const res = await request(httpServer)[route.method as 'get'](route.path)
      if (res.status !== 401) wrong.push(`${route.method.toUpperCase()} ${route.path} -> ${res.status}`)
    }
    expect(wrong).toEqual([])
  })

  for (const roleName of Object.keys(ROLE_PERMISSIONS)) {
    it(`${roleName}: allowed exactly where the catalogue says, 403 everywhere else`, async () => {
      const token = tokens.get(roleName)!
      const wrong: string[] = []
      for (const route of routes) {
        if (!route.policy) continue
        const allowed = route.policy === 'any_staff' || roleHasPermission(roleName, route.policy)
        const res = await request(httpServer)[route.method as 'get'](withOutlet(route.path, outletId)).set('Authorization', `Bearer ${token}`).send({})
        // Only the role gate's own refusal counts; a handler may still 403 for another reason (e.g. someone else's order).
        const refused = res.status === 403 && (res.body as { error?: { message?: string } }).error?.message === ROLE_REFUSAL
        if (allowed && refused) wrong.push(`${roleName} should reach ${route.method.toUpperCase()} ${route.path} (${route.policy}) but the role gate refused it`)
        if (!allowed && !refused) wrong.push(`${roleName} should be refused ${route.method.toUpperCase()} ${route.path} (${route.policy}) but got ${res.status}`)
      }
      expect(wrong).toEqual([])
    })
  }
})
