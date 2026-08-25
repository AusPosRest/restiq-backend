// CAP-7 success criteria, end to end: replaying an already-applied op returns
// duplicate with no double effect; a replayed-and-applied op leaves the DLQ
// (resolvedAt set, never deleted); bulk replay returns one result per op.
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as argon2 from 'argon2'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, PrismaClient } from '../src/db/client'
import { signOpsToken, uuidv7 } from '../src/platform'

const EMAIL = 'dlq-operator@restiq.example'

interface DeadLetterView {
  id: string
  tenantId: string
  tenantName: string
  deviceId: string
  deviceLabel: string
  opId: string
  reasonCode: string
  reasonText: string
  payloadMeta: Record<string, unknown>
  createdAt: string
  resolvedAt: string | null
}

async function wipe(prisma: PrismaClient): Promise<void> {
  // invoice/subscription (CAP-5) restrict-delete tenants; wiped first so this
  // helper is safe regardless of what another e2e file left behind (the test
  // suite shares one database and file execution order is not guaranteed).
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
  await prisma.clockEvent.deleteMany()
  await prisma.staffUser.deleteMany()
  await prisma.role.deleteMany()
  await prisma.outletCapability.deleteMany()
  await prisma.station.deleteMany()
  await prisma.printer.deleteMany()
  await prisma.diningTable.deleteMany()
  await prisma.floor.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.ownerInvite.deleteMany()
  await prisma.ownerUser.deleteMany()
  await prisma.checklistProgress.deleteMany()
  await prisma.tenantCapability.deleteMany()
  await prisma.tenantTaxRegistration.deleteMany()
  await prisma.auditEvent.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.tenantRegistryEntry.deleteMany()
  await prisma.onboardingDraft.deleteMany()
}

describe('/ops/v1/dead-letters (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaClient
  let httpServer: Parameters<typeof request>[0]
  let token: string
  let operatorId: string
  let tenantId: string
  let outletId: string
  let deviceId: string

  beforeAll(async () => {
    prisma = createPrismaClient()
    await wipe(prisma)
    await prisma.operatorUser.deleteMany({ where: { email: EMAIL } })
    const operator = await prisma.operatorUser.create({
      data: { email: EMAIL, passwordHash: await argon2.hash('irrelevant-here') },
    })
    operatorId = operator.id
    token = signOpsToken({ id: operator.id, email: operator.email })

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    httpServer = app.getHttpServer() as Parameters<typeof request>[0]
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await wipe(prisma)
    tenantId = uuidv7()
    await prisma.tenantRegistryEntry.create({ data: { tenantId, region: 'in-mumbai', lifecycle: 'active' } })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Spice Route Hospitality',
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
    const brand = await prisma.brand.create({ data: { tenantId, name: 'Spice Route' } })
    const outlet = await prisma.outlet.create({
      data: { tenantId, brandId: brand.id, name: 'Indiranagar', address: 'A1', type: 'dine_in', timezone: 'Asia/Kolkata' },
    })
    outletId = outlet.id
    const device = await prisma.device.create({
      data: {
        id: uuidv7(),
        tenantId,
        outletId,
        label: 'Terminal 1',
        type: 'pos',
        hardwareKeyFingerprint: 'fp-term-1',
        enrolledAt: new Date(),
      },
    })
    deviceId = device.id
  })

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`)
  }

  async function deadLetter(overrides?: Partial<{ reasonCode: string; reasonText: string; opId: string; deviceId: string; tenantId: string }>) {
    return prisma.syncDeadLetter.create({
      data: {
        tenantId: overrides?.tenantId ?? tenantId,
        deviceId: overrides?.deviceId ?? deviceId,
        opId: overrides?.opId ?? uuidv7(),
        reasonCode: overrides?.reasonCode ?? 'clock_skew',
        reasonText: overrides?.reasonText ?? 'Device clock is 4m ahead of server time',
        payloadMeta: { kind: 'order.sync' },
      },
    })
  }

  describe('GET /ops/v1/dead-letters', () => {
    it('lists unresolved rows with tenant and device names joined in, no payload body', async () => {
      const row = await deadLetter()
      const res = await authed(request(httpServer).get('/ops/v1/dead-letters'))
      expect(res.status).toBe(200)
      const body = res.body as { deadLetters: DeadLetterView[]; total: number }
      expect(body.total).toBe(1)
      expect(body.deadLetters[0]).toMatchObject({
        id: row.id,
        tenantName: 'Spice Route Hospitality',
        deviceLabel: 'Terminal 1',
        reasonCode: 'clock_skew',
      })
      // NFR-15: metadata only, never an order payload body.
      expect(body.deadLetters[0]?.payloadMeta).toEqual({ kind: 'order.sync' })
    })

    it('excludes resolved rows', async () => {
      const row = await deadLetter()
      await prisma.syncDeadLetter.update({ where: { id: row.id }, data: { resolvedAt: new Date() } })
      const res = await authed(request(httpServer).get('/ops/v1/dead-letters'))
      const body = res.body as { total: number }
      expect(body.total).toBe(0)
    })

    it('filters by tenantId, deviceId and reasonCode', async () => {
      await deadLetter({ reasonCode: 'clock_skew' })
      await deadLetter({ reasonCode: 'stale_price_version' })
      const otherDevice = await prisma.device.create({
        data: { id: uuidv7(), tenantId, outletId, label: 'Terminal 2', type: 'pos', hardwareKeyFingerprint: 'fp-term-2', enrolledAt: new Date() },
      })
      await deadLetter({ deviceId: otherDevice.id, reasonCode: 'schema_skew' })

      const byReason = (await authed(request(httpServer).get('/ops/v1/dead-letters?reasonCode=clock_skew'))).body as { total: number }
      expect(byReason.total).toBe(1)

      const byDevice = (await authed(request(httpServer).get(`/ops/v1/dead-letters?deviceId=${otherDevice.id}`))).body as { total: number }
      expect(byDevice.total).toBe(1)

      const byTenant = (await authed(request(httpServer).get(`/ops/v1/dead-letters?tenantId=${tenantId}`))).body as { total: number }
      expect(byTenant.total).toBe(3)
    })

    it('rejects without an ops token', async () => {
      expect((await request(httpServer).get('/ops/v1/dead-letters')).status).toBe(401)
    })
  })

  describe('POST /ops/v1/dead-letters/:id/replay', () => {
    it('replays an unresolved recoverable op: applies it, resolves the row, audits it', async () => {
      const row = await deadLetter({ reasonCode: 'clock_skew' })
      const res = await authed(request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`)).send({ reason: 'Device clock corrected by outlet manager' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ id: row.id, status: 'applied' })

      const updated = await prisma.syncDeadLetter.findUnique({ where: { id: row.id } })
      expect(updated?.resolvedAt).not.toBeNull()
      expect(await prisma.appliedOp.count({ where: { opId: row.opId } })).toBe(1)

      const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'dlq.replayed' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ actorId: operatorId, actorEmail: EMAIL, reason: 'Device clock corrected by outlet manager' })
    })

    it('replaying an already-applied op returns duplicate with zero side effects', async () => {
      const row = await deadLetter({ reasonCode: 'clock_skew' })
      await authed(request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`)).send({ reason: 'first replay' })

      const resolvedAtAfterFirst = (await prisma.syncDeadLetter.findUnique({ where: { id: row.id } }))?.resolvedAt
      const auditCountAfterFirst = await prisma.auditEvent.count()

      const res = await authed(request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`)).send({ reason: 'second replay' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ id: row.id, status: 'duplicate' })

      // Zero side effects: nothing about the row, ledger, or audit trail changed.
      expect(await prisma.appliedOp.count({ where: { opId: row.opId } })).toBe(1)
      expect((await prisma.syncDeadLetter.findUnique({ where: { id: row.id } }))?.resolvedAt).toEqual(resolvedAtAfterFirst)
      expect(await prisma.auditEvent.count()).toBe(auditCountAfterFirst)
    })

    it('replaying a non-recoverable op returns rejected-again and leaves it unresolved in the queue', async () => {
      const row = await deadLetter({ reasonCode: 'schema_skew' })
      const res = await authed(request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`)).send({ reason: 'Retried after app update rollout' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ id: row.id, status: 'rejected-again' })

      const updated = await prisma.syncDeadLetter.findUnique({ where: { id: row.id } })
      expect(updated?.resolvedAt).toBeNull()
      expect(await prisma.appliedOp.count({ where: { opId: row.opId } })).toBe(0)
      // Still unresolved, so it still surfaces in the queue - never dropped.
      const list = (await authed(request(httpServer).get('/ops/v1/dead-letters'))).body as { total: number }
      expect(list.total).toBe(1)
    })

    it('rejects replay without a reason and changes nothing', async () => {
      const row = await deadLetter()
      const before = await prisma.auditEvent.count()
      const res = await authed(request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`)).send({})
      expect(res.status).toBe(400)
      expect((await prisma.syncDeadLetter.findUnique({ where: { id: row.id } }))?.resolvedAt).toBeNull()
      expect(await prisma.auditEvent.count()).toBe(before)
    })

    it('404s for an unknown dead letter', async () => {
      const res = await authed(request(httpServer).post(`/ops/v1/dead-letters/${uuidv7()}/replay`)).send({ reason: 'x' })
      expect(res.status).toBe(404)
    })

    it('rejects without an ops token', async () => {
      const row = await deadLetter()
      const res = await request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`).send({ reason: 'x' })
      expect(res.status).toBe(401)
    })

    it('never deletes a dead-letter row - only resolvedAt ever changes', async () => {
      const row = await deadLetter({ reasonCode: 'clock_skew' })
      const before = await prisma.syncDeadLetter.count()
      await authed(request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`)).send({ reason: 'x' })
      await authed(request(httpServer).post(`/ops/v1/dead-letters/${row.id}/replay`)).send({ reason: 'x again' })
      expect(await prisma.syncDeadLetter.count()).toBe(before)
    })
  })

  describe('POST /ops/v1/dead-letters/replay-bulk', () => {
    it('replays an explicit id list, returning one result per op with the right status each', async () => {
      const applied = await deadLetter({ reasonCode: 'clock_skew' })
      const alreadyApplied = await deadLetter({ reasonCode: 'stale_price_version' })
      await authed(request(httpServer).post(`/ops/v1/dead-letters/${alreadyApplied.id}/replay`)).send({ reason: 'pre-applied' })
      const stuck = await deadLetter({ reasonCode: 'schema_skew' })

      const res = await authed(request(httpServer).post('/ops/v1/dead-letters/replay-bulk')).send({
        reason: 'Bulk remediation after outbox fix',
        ids: [applied.id, alreadyApplied.id, stuck.id],
      })
      expect(res.status).toBe(200)
      const body = res.body as { results: Array<{ id: string; status: string }> }
      expect(body.results).toHaveLength(3)
      expect(body.results).toEqual(
        expect.arrayContaining([
          { id: applied.id, status: 'applied' },
          { id: alreadyApplied.id, status: 'duplicate' },
          { id: stuck.id, status: 'rejected-again' },
        ]),
      )
    })

    it('replays by filter (tenant + reasonCode), touching only matching unresolved rows', async () => {
      const match1 = await deadLetter({ reasonCode: 'clock_skew' })
      const match2 = await deadLetter({ reasonCode: 'clock_skew' })
      await deadLetter({ reasonCode: 'stale_price_version' })

      const res = await authed(request(httpServer).post('/ops/v1/dead-letters/replay-bulk')).send({
        reason: 'Bulk clock-skew remediation',
        tenantId,
        reasonCode: 'clock_skew',
      })
      expect(res.status).toBe(200)
      const body = res.body as { results: Array<{ id: string; status: string }> }
      expect(body.results.map((r) => r.id).sort()).toEqual([match1.id, match2.id].sort())
      expect(body.results.every((r) => r.status === 'applied')).toBe(true)

      const remaining = (await authed(request(httpServer).get('/ops/v1/dead-letters?reasonCode=stale_price_version'))).body as { total: number }
      expect(remaining.total).toBe(1)
    })

    it('replays every unresolved op fleet-wide when neither ids nor a filter is given - the "Replay all" case', async () => {
      const a = await deadLetter({ reasonCode: 'clock_skew' })
      const b = await deadLetter({ reasonCode: 'stale_price_version' })

      const res = await authed(request(httpServer).post('/ops/v1/dead-letters/replay-bulk')).send({ reason: 'Replay everything' })
      expect(res.status).toBe(200)
      const body = res.body as { results: Array<{ id: string; status: string }> }
      expect(body.results.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    })

    it('rejects an explicit empty id list as ambiguous', async () => {
      expect((await authed(request(httpServer).post('/ops/v1/dead-letters/replay-bulk')).send({ reason: 'x', ids: [] })).status).toBe(400)
    })

    it('rejects a bulk replay without a reason', async () => {
      expect((await authed(request(httpServer).post('/ops/v1/dead-letters/replay-bulk')).send({})).status).toBe(400)
    })

    it('rejects without an ops token', async () => {
      const res = await request(httpServer).post('/ops/v1/dead-letters/replay-bulk').send({ reason: 'x', ids: [] })
      expect(res.status).toBe(401)
    })
  })
})
