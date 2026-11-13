// Hub op recorder (#300, HUB-BUILD-PLAN H3) against the real cloud: the hub
// imports the cloud's bootstrap, rings up a whole sale offline, and the ops it
// recorded go through the cloud's own SyncPushService. Every op must be
// accepted and the cloud must end up with the same bill, tax and tenders.
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { createPrismaClient, setPrismaClient, type PrismaClient } from '../src/db/client'
import { createHubApp } from '../src/hub/hub.module'
import { importBootstrap } from '../src/hub/import'
import { readOutbox } from '../src/hub/outbox'
import { openStore } from '../src/hub/store'
import { PrismaService, uuidv7, type DevicePrincipal } from '../src/platform'
import { SyncPushService, SyncService } from '../src/pos'
import { ringUpSale, SALE_OP_TYPES, seedSaleFixture, seedTenantRows, type SaleFixture } from './hub-seed'

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations')
type Row = Record<string, unknown>

describe('hub ops pushed to the cloud (e2e)', () => {
  let cloud: PrismaClient
  let cloudApp: INestApplication
  let hub: PGlite
  let hubApp: INestApplication
  let device: DevicePrincipal
  let f: SaleFixture
  const dataDir = mkdtempSync(join(tmpdir(), 'restiq-hub-ops-e2e-'))

  async function hubRows(sql: string, params: unknown[]): Promise<Row[]> {
    return hub.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE NONE')
      return (await tx.query<Row>(sql, params)).rows
    })
  }

  beforeAll(async () => {
    cloud = createPrismaClient()
    // The cloud app on its own client; the process-wide one (setPrismaClient) is the hub's.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ client: cloud, onModuleDestroy: () => Promise.resolve() })
      .compile()
    cloudApp = moduleRef.createNestApplication()
    await cloudApp.init()

    f = await seedSaleFixture(cloud, await seedTenantRows(cloud, 'Hub Ops'))
    const hubDevice = await cloud.device.create({
      data: { tenantId: f.tenantId, outletId: f.outletId, label: 'Hub', type: 'pos', role: 'hub', hardwareKeyFingerprint: `hub-${uuidv7()}`, enrolledAt: new Date() },
    })
    device = { deviceId: hubDevice.id, tenantId: f.tenantId, outletId: f.outletId, isHub: true }

    const store = await openStore(undefined, MIGRATIONS)
    hub = store.pg
    setPrismaClient(store.prisma)
    await importBootstrap(hub, await cloudApp.get(SyncService).bootstrap(device), dataDir)
    hubApp = await createHubApp(hub, dataDir)
    await hubApp.init()
  }, 60_000)

  afterAll(async () => {
    await hubApp?.close()
    await hub?.close()
    await cloudApp?.close()
    rmSync(dataDir, { recursive: true, force: true })
    if (device) {
      const where = { tenantId: device.tenantId }
      await cloud.appliedOp.deleteMany({ where: { deviceId: device.deviceId } })
      await cloud.syncDeadLetter.deleteMany({ where })
      await cloud.tender.deleteMany({ where })
      await cloud.bill.deleteMany({ where })
      await cloud.billNumberCounter.deleteMany({ where })
      await cloud.tokenNumberCounter.deleteMany({ where })
      await cloud.ticketLine.deleteMany({ where })
      await cloud.ticketEvent.deleteMany({ where })
      await cloud.ticket.deleteMany({ where })
      await cloud.orderLineModifier.deleteMany({ where })
      await cloud.orderLine.deleteMany({ where: { ...where, parentLineId: { not: null } } })
      await cloud.orderLine.deleteMany({ where })
      await cloud.order.deleteMany({ where })
      await cloud.cashMovement.deleteMany({ where })
      await cloud.shift.deleteMany({ where })
      await cloud.clockEvent.deleteMany({ where })
      await cloud.auditEvent.deleteMany({ where })
      await cloud.device.deleteMany({ where })
      await cloud.staffUser.deleteMany({ where })
      await cloud.role.deleteMany({ where })
      await cloud.comboSlotOption.deleteMany({ where })
      await cloud.comboSlot.deleteMany({ where })
      await cloud.combo.deleteMany({ where })
      await cloud.itemModifierGroup.deleteMany({ where })
      await cloud.modifier.deleteMany({ where })
      await cloud.modifierGroup.deleteMany({ where })
      await cloud.itemPrice.deleteMany({ where })
      await cloud.menuItem.deleteMany({ where })
      await cloud.menuCategory.deleteMany({ where })
      await cloud.station.deleteMany({ where })
      await cloud.diningTable.deleteMany({ where })
      await cloud.floor.deleteMany({ where })
      await cloud.outlet.deleteMany({ where })
      await cloud.brand.deleteMany({ where })
      await cloud.syncChange.deleteMany({ where })
      await cloud.tenant.deleteMany({ where: { id: device.tenantId } })
      await cloud.tenantRegistryEntry.deleteMany({ where: { tenantId: device.tenantId } })
    }
    await cloud?.$disconnect()
  })

  it('records the sale on the hub; the cloud accepts every op and ends with the same bill, tax and tenders', async () => {
    const { billId } = await ringUpSale(hubApp.getHttpServer() as Parameters<typeof ringUpSale>[0], f)
    const ops = await readOutbox(hub)
    expect(ops.map((op) => op.type)).toEqual(SALE_OP_TYPES)

    const results = await cloudApp.get(SyncPushService).push(device, uuidv7(), ops)
    expect(results.filter((r) => r.status !== 'accepted')).toEqual([])
    expect(results).toHaveLength(ops.length)

    const [hubBill] = await hubRows(
      `SELECT id, bill_number::int, subtotal_minor::text, tax_minor::text, discount_minor::text, round_off_minor::text, status::text, finalized_by_staff_id FROM bills WHERE id = $1`,
      [billId],
    )
    const cloudBill = await cloud.bill.findUniqueOrThrow({ where: { id: billId }, include: { tenders: { orderBy: { id: 'asc' } } } })
    expect({
      id: cloudBill.id,
      bill_number: cloudBill.billNumber,
      subtotal_minor: String(cloudBill.subtotalMinor),
      tax_minor: String(cloudBill.taxMinor),
      discount_minor: cloudBill.discountMinor === null ? null : String(cloudBill.discountMinor),
      round_off_minor: cloudBill.roundOffMinor === null ? null : String(cloudBill.roundOffMinor),
      status: cloudBill.status,
      finalized_by_staff_id: cloudBill.finalizedByStaffId,
    }).toEqual(hubBill)
    expect(Number(cloudBill.taxMinor)).toBeGreaterThan(0)

    const hubTenders = await hubRows(`SELECT id, method::text, amount_minor::text, tendered_minor::text FROM tenders WHERE bill_id = $1 ORDER BY id`, [billId])
    expect(cloudBill.tenders.map((t) => ({ id: t.id, method: t.method, amount_minor: String(t.amountMinor), tendered_minor: t.tenderedMinor === null ? null : String(t.tenderedMinor) }))).toEqual(
      hubTenders,
    )

    // Same lines, ids, prices and modifiers on both sides (including the voided one and the combo's children).
    const lines = `SELECT l.id, l.item_id, l.combo_id, l.parent_line_id, l.quantity, l.unit_price_minor::text, l.note, l.voided_at IS NOT NULL AS voided,
        coalesce((SELECT jsonb_object_agg(m.modifier_id, m.price_minor::text) FROM order_line_modifiers m WHERE m.order_line_id = l.id), '{}') AS modifiers
      FROM order_lines l WHERE l.tenant_id = $1::uuid ORDER BY l.id`
    const cloudLines = await cloud.$queryRawUnsafe<Row[]>(lines, f.tenantId)
    expect(cloudLines).toEqual(await hubRows(lines, [f.tenantId]))
    expect(cloudLines).toHaveLength(4) // dosa, the voided coffee, the combo and its child - the removed line is gone on both

    const hubShift = await hubRows(`SELECT id, float_minor::text, counted_minor::text, expected_minor::text FROM shifts`, [])
    const cloudShift = await cloud.$queryRawUnsafe<Row[]>(`SELECT id, float_minor::text, counted_minor::text, expected_minor::text FROM shifts WHERE tenant_id = $1::uuid`, f.tenantId)
    expect(cloudShift).toEqual(hubShift)
  }, 60_000)
})
