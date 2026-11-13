// Hub op recorder (#300, HUB-BUILD-PLAN H3) on in-memory PGlite: a whole sale
// rung up through the hub's HTTP API records one op per write, in seq order,
// fsynced to the journal before the reply, and every payload passes the
// cloud's own Sync*Payload validation.
// First, as in hub.module: pos and admin import each other.
import '../pos'
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import type { NextFunction, Request, Response } from 'express'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HUB_PIN, ringUpSale, SALE_OP_TYPES, seedSaleFixture, seedTenantRows, type SaleFixture } from '../../test/hub-seed'
import { setPrismaClient } from '../db/client'
import { UpdateOrderLineDto, UpdateOrderStatusDto } from '../pos/orders/orders.dtos'
import * as dtos from '../pos/sync/sync.dtos'
import { ROUTES } from './allowlist'
import { createHubApp } from './hub.module'
import { appendOp, compactJournal, readAck, readJournal, writeAck } from './journal'
import { OP_MAP, routeKey } from './op-map'
import { readOutbox, type HubOp } from './outbox'
import { APP_ROLE, openStore } from './store'

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations')

// The classes SyncPushService.apply parses each op type's payload with.
const PAYLOAD_CLASSES: Record<string, (new () => object)[]> = {
  'order.create': [dtos.SyncOrderCreatePayload],
  'order.line.add': [dtos.SyncLineAddPayload],
  'order.line.update': [dtos.SyncLineRefPayload, UpdateOrderLineDto],
  'order.line.remove': [dtos.SyncLineRefPayload],
  'order.status': [dtos.SyncOrderRefPayload, UpdateOrderStatusDto],
  'bill.create': [dtos.SyncBillCreatePayload],
  'bill.finalize': [dtos.SyncBillFinalizePayload],
  'order.combo.add': [dtos.SyncComboAddPayload],
  'order.line.void': [dtos.SyncLineVoidPayload],
  'order.transfer': [dtos.SyncOrderTransferPayload],
  'order.discard': [dtos.SyncOrderRefPayload],
  'shift.open': [dtos.SyncShiftOpenPayload],
  'shift.cash_movement': [dtos.SyncCashMovementPayload],
  'shift.close': [dtos.SyncShiftClosePayload],
  'clock.in': [dtos.SyncClockPayload],
  'clock.out': [dtos.SyncClockPayload],
  'ticket.bump': [dtos.SyncTicketPayload],
  'ticket.recall': [dtos.SyncTicketPayload],
}

describe('hub op recorder on PGlite', () => {
  let pg: PGlite
  let app: INestApplication
  let http: Parameters<typeof request>[0]
  let f: SaleFixture
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-ops-'))
  // What outbox.log held at the moment each reply was handed to Express.
  const journalAtReply = new Map<string, HubOp[]>()

  beforeAll(async () => {
    process.env.POS_JWT_SECRET = 'hub-ops-spec-secret'
    const store = await openStore(undefined, MIGRATIONS)
    pg = store.pg
    setPrismaClient(store.prisma)
    await pg.exec('RESET ROLE')
    f = await seedSaleFixture(store.prisma, await seedTenantRows(store.prisma, 'Ops'))
    await pg.exec(`SET ROLE ${APP_ROLE}`)
    app = await createHubApp(pg, dataDir)
    app.use((req: Request, res: Response, next: NextFunction) => {
      const send = res.send.bind(res)
      res.send = (body?: unknown) => {
        journalAtReply.set(`${req.method} ${req.path}`, readJournal(dataDir))
        return send(body)
      }
      next()
    })
    await app.init()
    http = app.getHttpServer() as Parameters<typeof request>[0]
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pg?.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('maps every write route the hub allows, and nothing else', () => {
    const writes = ROUTES.filter((route) => !route.startsWith('GET ')).map((route) => routeKey(...(route.split(' ') as [string, string])))
    const mapped = Object.keys(OP_MAP).map((route) => routeKey(...(route.split(' ') as [string, string])))
    expect(mapped.sort()).toEqual(writes.sort())
  })

  let ops: HubOp[]

  it('records one op per write of a whole sale, in seq order, mirrored in the journal', async () => {
    const { billId } = await ringUpSale(http, f)
    ops = await readOutbox(pg)
    expect(ops.map((op) => op.type)).toEqual(SALE_OP_TYPES)
    expect(ops.map((op) => op.seq)).toEqual(SALE_OP_TYPES.map((_, i) => i + 1))
    expect(new Set(ops.map((op) => op.opId)).size).toBe(ops.length)
    expect(readJournal(dataDir)).toEqual(ops)
    expect(new Set(ops.map((op) => op.type))).toEqual(new Set(Object.keys(PAYLOAD_CLASSES)))

    const finalize = ops.find((op) => op.type === 'bill.finalize')!
    expect(finalize.payload).toMatchObject({ billId, tenders: [{ method: 'cash', amountMinor: 1000 }, { method: 'cash' }] })
    expect(finalize.actorStaffId).toBe(f.staffId)
    const line = ops.find((op) => op.type === 'order.line.add')!
    expect(line.payload).toMatchObject({ itemId: f.itemId, quantity: 2, modifierIds: [f.gheeId], modifierPriceMinor: { [f.gheeId]: '1500' }, unitPriceMinor: '12000', note: 'less spicy' })
    expect(ops.find((op) => op.type === 'order.combo.add')!.payload).toMatchObject({
      comboId: f.comboId,
      unitPriceMinor: '15000',
      children: [{ itemId: f.itemId, quantity: 1, unitPriceMinor: '500', modifierPriceMinor: { [f.gheeId]: '1500' } }],
    })
    expect(ops.find((op) => op.type === 'order.line.void')!.payload).toMatchObject({ reason: 'Spilled', approvedByStaffId: f.managerId })
    expect(ops.find((op) => op.type === 'ticket.bump')!.payload).toEqual({ orderId: expect.any(String) as string, stationId: f.stationId })
    // No PIN ever leaves the hub.
    expect(readFileSync(join(dataDir, 'outbox.log'), 'utf8')).not.toMatch(/pin/i)
  }, 60_000)

  it('builds every payload the cloud accepts: each passes its Sync*Payload validation', async () => {
    for (const op of ops) {
      for (const cls of PAYLOAD_CLASSES[op.type]) {
        const errors = await validate(plainToInstance(cls, op.payload), { whitelist: true })
        expect(errors, `${op.type} as ${cls.name}`).toEqual([])
      }
    }
  })

  it('has each op fsynced in the journal before its reply is sent', () => {
    const [finalize] = ops.filter((op) => op.type === 'bill.finalize')
    const atReply = journalAtReply.get(`POST /pos/v1/bills/${finalize.payload.billId as string}/finalize`)
    expect(atReply?.at(-1)).toEqual(finalize)
    expect(journalAtReply.get('POST /pos/v1/clock/out')?.at(-1)?.type).toBe('clock.out')
  })

  it('refuses a refund and card payments 409 offline_unsupported, recording nothing', async () => {
    const login = await request(http).post('/pos/v1/auth/login').send({ tenantId: f.tenantId, pin: HUB_PIN }).expect(200)
    const auth = { Authorization: `Bearer ${(login.body as { token: string }).token}` }
    const billId = ops.find((op) => op.type === 'bill.create')!.payload.billId as string
    const before = (await readOutbox(pg)).length
    const refund = await request(http).post(`/pos/v1/bills/${billId}/refund`).set(auth).send({ managerPin: '8765', reason: 'Cold' }).expect(409)
    expect(refund.body).toMatchObject({ error: { code: 'offline_unsupported' } })
    await request(http).post(`/pos/v1/bills/${billId}/intents`).set(auth).send({}).expect(409)
    expect(await readOutbox(pg)).toHaveLength(before)
    expect(readJournal(dataDir)).toHaveLength(before)
  })

  it('records nothing for a write that fails', async () => {
    const before = (await readOutbox(pg)).length
    await request(http).post('/pos/v1/clock/out').set('Authorization', 'Bearer nope').expect(401)
    expect(await readOutbox(pg)).toHaveLength(before)
  })

  it('compacts the journal at startup only once every op is acknowledged', () => {
    const last = readJournal(dataDir).at(-1)!.seq
    writeAck(dataDir, last - 1)
    expect(compactJournal(dataDir)).toBe(false)
    expect(readJournal(dataDir).length).toBeGreaterThan(0)
    writeAck(dataDir, last)
    expect(readAck(dataDir)).toBe(last)
    expect(compactJournal(dataDir)).toBe(true)
    expect(readJournal(dataDir)).toEqual([])
  })

  it('skips a torn last journal line (power cut mid-append), but no other', () => {
    appendOp(dataDir, ops[0])
    appendFileSync(join(dataDir, 'outbox.log'), '{"opId":"torn')
    expect(readJournal(dataDir)).toEqual([ops[0]])
    appendFileSync(join(dataDir, 'outbox.log'), '\n{}\n')
    expect(() => readJournal(dataDir)).toThrow()
  })
})
