// Hub mode (#306, HUB-BUILD-PLAN H5): startup recovery, before the hub listens.
// PGlite cannot fsync, so after a power cut its files may be gone, unreadable
// or a few seconds behind; outbox.log (fsynced per op), outbox.ack and
// bootstrap.json are what the hub trusts. hub-main calls openOrRebuild, then
// (once the app exists, for its services) reconcile.
import type { PGlite } from '@electric-sql/pglite'
import { Logger, type INestApplicationContext } from '@nestjs/common'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { getPrisma } from '../db/client'
import { KitchenTicketsService } from '../kitchen'
import { BillsService } from '../pos/bills/bills.service'
import { ClockService } from '../pos/clock/clock.service'
import { OrderLinesService } from '../pos/orders/order-lines.service'
import { OrdersService } from '../pos/orders/orders.service'
import { ShiftsService } from '../pos/shifts/shifts.service'
import { applyOp, type OpServices } from '../pos/sync/sync-push.service'
import { importBootstrap, type BootstrapPayload } from './import'
import { readAck, readJournal, repairJournal } from './journal'
import { readMeta } from './meta'
import { insertOp } from './outbox'
import { openStore, type HubStore } from './store'

const logger = new Logger('HubRecovery')
/** What survives a rebuild: copied from the broken dir into the fresh one. */
const KEEP = ['outbox.log', 'outbox.ack', 'bootstrap.json']

/**
 * Opens the store at dataDir. When PGlite cannot open it, or it opens with no
 * hub_meta although outbox.log exists (its database files were lost), moves
 * the dir aside to <dataDir>.broken-<ms>, opens a fresh store there and imports
 * bootstrap.json into it (offline-safe). reconcile() then replays the journal.
 */
export async function openOrRebuild(dataDir: string, migrationsDir: string): Promise<HubStore> {
  let store: HubStore | undefined
  try {
    store = await openStore(dataDir, migrationsDir)
    if ((await readMeta(store.pg)) || !existsSync(join(dataDir, 'outbox.log'))) return store
    logger.error('RECOVERY: the hub database has no hub_meta but outbox.log exists - its files were lost')
  } catch (error) {
    logger.error(`RECOVERY: the hub database would not open: ${String(error)}`)
  }
  await store?.pg.close().catch(() => undefined)

  const KEEP_CONTACT = ['bootstrap.json', 'outbox.ack']
  const broken = `${dataDir}.broken-${Date.now()}`
  renameSync(dataDir, broken)
  mkdirSync(dataDir)
  const fresh = await openStore(dataDir, migrationsDir)
  for (const name of KEEP) {
    if (!existsSync(join(broken, name))) continue
    copyFileSync(join(broken, name), join(dataDir, name))
    const { atime, mtime } = statSync(join(broken, name))
    utimesSync(join(dataDir, name), atime, mtime) // keep the times: they date the last real contact with the cloud
  }
  const bootstrap = join(dataDir, 'bootstrap.json')
  if (existsSync(bootstrap)) {
    // The rebuild must not restart the O1 offline clock: the last real contact with the cloud is the newer of
    // bootstrap.json (written on each bootstrap) and outbox.ack (written on each acked push). Read it before the
    // import below rewrites bootstrap.json, and put that time back on the file so a later rebuild dates the same.
    const lastContact = new Date(Math.max(...KEEP_CONTACT.filter((n) => existsSync(join(dataDir, n))).map((n) => statSync(join(dataDir, n)).mtimeMs)))
    await importBootstrap(fresh.pg, JSON.parse(readFileSync(bootstrap, 'utf8')) as BootstrapPayload, dataDir)
    utimesSync(bootstrap, lastContact, lastContact)
    // bootstrap.json predates every open sale whose op was already acked (the journal replays only unacked ones).
    await fresh.pg.query(
      `UPDATE hub_meta SET open_sales_resync = true, last_sync_at = $1,
         must_sync_before = $1::timestamptz + make_interval(hours => (policy->>'maxOfflineHours')::int)`,
      [lastContact.toISOString()],
    )
    logger.warn(`RECOVERY: moved the broken database to ${broken} and rebuilt it from bootstrap.json; the journal is replayed next`)
  } else {
    logger.error(`RECOVERY: moved the broken database to ${broken}; no bootstrap.json, so the hub bootstraps from the cloud when it next syncs`)
  }
  return fresh
}

/**
 * Brings hub_outbox back in line with the journal, then records orphans.
 * Each journal op the outbox lacks (a power cut between the journal fsync and
 * the outbox insert, or a rebuilt store) is inserted - acknowledged ones as
 * acknowledged, so the next seq stays right. Unacknowledged ones are first
 * applied locally through applyOp with their own ids and time: a no-op when
 * the hub's tables already hold them (the repeat checks that make a re-sent
 * push safe), the sale itself when PGlite lost it. A replay the services
 * refuse is logged; its op is still pushed, so the cloud decides.
 */
export async function reconcile(app: INestApplicationContext, pg: PGlite, dataDir: string): Promise<void> {
  repairJournal(dataDir)
  const ack = readAck(dataDir)
  const have = new Set((await pg.query<{ opId: string }>('SELECT op_id AS "opId" FROM hub_outbox')).rows.map((row) => row.opId))
  const missing = readJournal(dataDir).filter((op) => !have.has(op.opId))
  const meta = await readMeta(pg)
  const services: OpServices = {
    plane: getPrisma(),
    orders: app.get(OrdersService),
    orderLines: app.get(OrderLinesService),
    bills: app.get(BillsService),
    shifts: app.get(ShiftsService),
    clock: app.get(ClockService),
    tickets: app.get(KitchenTicketsService),
  }
  let refused = 0
  for (const op of missing) {
    if (op.seq > ack && meta) {
      try {
        await applyOp(services, { deviceId: meta.deviceId ?? '', tenantId: meta.tenantId, outletId: meta.outletId, isHub: true }, op)
      } catch (error) {
        refused++
        logger.warn(`RECOVERY: replaying op seq ${op.seq} (${op.type}) on the hub failed, pushing it anyway: ${String(error)}`)
      }
    }
    await insertOp(pg, op)
    if (op.seq <= ack) await pg.query('UPDATE hub_outbox SET acked_at = now() WHERE op_id = $1', [op.opId])
  }
  if (missing.length > 0) logger.warn(`RECOVERY: ${missing.length} journal op(s) were missing from the outbox and are back (${refused} replay(s) refused)`)
  const orphans = await recordOrphans(pg)
  if (orphans > 0) logger.error(`RECOVERY: ${orphans} new orphan(s) - sales rows with no op; see hub_orphans`)
}

/**
 * Hub sales rows since the oldest unacknowledged op with no op in the outbox:
 * orders, lines and bills created, and bills finalized. Returns how many are new.
 * ponytail: with every op acknowledged there is no window, so nothing is checked.
 */
async function recordOrphans(pg: PGlite): Promise<number> {
  const has = (type: string, key: string, id: string) => `EXISTS (SELECT 1 FROM hub_outbox WHERE type = '${type}' AND payload->>'${key}' = ${id}::text)`
  return pg.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE NONE') // superuser, past RLS
    const { affectedRows } = await tx.query(`
      WITH since AS (SELECT min(at) AS at FROM hub_outbox WHERE acked_at IS NULL), hub AS (SELECT outlet_id FROM hub_meta)
      INSERT INTO hub_orphans (entity, entity_id, created_at)
      SELECT 'order', o.id, o.created_at FROM orders o, since, hub
        WHERE o.outlet_id = hub.outlet_id AND o.created_at >= since.at AND NOT ${has('order.create', 'orderId', 'o.id')}
      UNION ALL
      SELECT 'order_line', l.id, l.created_at FROM order_lines l JOIN orders o ON o.id = l.order_id, since, hub
        WHERE o.outlet_id = hub.outlet_id AND l.created_at >= since.at AND NOT ${has('order.line.add', 'lineId', 'l.id')}
          AND NOT ${has('order.combo.add', 'lineId', 'l.id')}
          AND NOT EXISTS (SELECT 1 FROM hub_outbox, jsonb_array_elements(payload->'children') c WHERE type = 'order.combo.add' AND c->>'lineId' = l.id::text)
      UNION ALL
      SELECT 'bill', b.id, b.created_at FROM bills b, since, hub
        WHERE b.outlet_id = hub.outlet_id AND b.created_at >= since.at AND NOT ${has('bill.create', 'billId', 'b.id')}
      UNION ALL
      SELECT 'bill_finalized', b.id, b.finalized_at FROM bills b, since, hub
        WHERE b.outlet_id = hub.outlet_id AND b.finalized_at >= since.at AND NOT ${has('bill.finalize', 'billId', 'b.id')}
      ON CONFLICT (entity, entity_id) DO NOTHING`)
    return affectedRows ?? 0
  })
}
