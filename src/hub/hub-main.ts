// Hub mode entrypoint (#293): the backend's own POS and kitchen code on an
// in-process PGlite store, for the Windows hub till (HUB-BUILD-PLAN §2).
// Listens on 127.0.0.1 only and sends no CORS headers - the local Next server
// is the only caller. Env: HUB_DATA_DIR, HUB_PORT (default 8180), POS_JWT_SECRET.
//
// Sync worker (#304, H4): starts once the device key arrives. In production the
// Electron parent sends it over process.parentPort - never env or disk:
//   { type: 'device-key', pem, deviceId, cloudUrl, appVersion? }
// HUB_CLOUD_URL / HUB_DEVICE_ID fill a missing cloudUrl / deviceId (hub_meta's
// device_id too). HUB_DEVICE_KEY_PEM is for tests and local runs only.
// Status (H6, restiq-desktop D3): a { type: 'status', ... } message (desktop-port.ts)
// goes to the parent after listen, after the worker starts and after every tick.
// Shutdown: SIGTERM, SIGINT or a parentPort { type: 'shutdown' } stops the
// worker, closes the app and PGlite, then exits 0.
import 'reflect-metadata'
import type { PGlite } from '@electric-sql/pglite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setPrismaClient } from '../db/client'
import { listenToParent, statusMessage, type DeviceKeyMessage, type ParentPort } from './desktop-port'
import { createHubApp } from './hub.module'
import { HubContext } from './lock.guard'
import { compactJournal } from './journal'
import { readMeta } from './meta'
import { openOrRebuild, reconcile } from './recovery'
import { devicePrivateKey } from './signer'
import { SyncWorker } from './sync-worker'

/** Electron's utilityProcess port to the main process; absent under plain node. */
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function main(): Promise<void> {
  // Filled in as startup gets that far; shutdown closes whatever exists.
  const open: { pg?: PGlite; app?: Awaited<ReturnType<typeof createHubApp>> } = {}
  let worker: SyncWorker | undefined
  let closing: Promise<void> | undefined
  const shutdown = () => {
    closing ??= (async () => {
      await worker?.stop()
      await open.app?.close()
      await open.pg?.close()
    })().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('hub shutdown failed:', error)
        process.exit(1)
      },
    )
  }
  // First thing, so a device key sent while the store opens is held, not lost (restiq-desktop D3).
  const parent = listenToParent(parentPort, shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  const dataDir = required('HUB_DATA_DIR')
  required('POS_JWT_SECRET')
  const port = Number(process.env.HUB_PORT ?? 8180)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('HUB_PORT must be a port number')
  // The hub never talks to Stripe: without a key every Stripe call answers 503 payments_not_configured.
  delete process.env.STRIPE_SECRET_KEY

  // Bundled: dist-hub/migrations next to hub.cjs. Unbundled (dist/hub/hub-main.js): the repo's prisma/migrations.
  const migrationsDir = [join(__dirname, 'migrations'), join(__dirname, '..', '..', 'prisma', 'migrations')].find((dir) => existsSync(dir))
  if (!migrationsDir) throw new Error('No migrations directory found next to the hub')

  // H5 (#306): a broken store is rebuilt from bootstrap.json before anything else touches it.
  const store = await openOrRebuild(dataDir, migrationsDir)
  const db = (open.pg = store.pg)
  // ponytail: only at startup - nothing appends while this runs.
  compactJournal(dataDir)
  setPrismaClient(store.prisma)
  const app = (open.app = await createHubApp(db, dataDir, () => worker?.kick(), new HubContext(db, undefined, () => worker)))
  // H5 (#306): journal ops back into the outbox (replayed locally), orphans recorded - before the first request.
  await reconcile(app, db, dataDir)
  await app.listen(port, '127.0.0.1')
  console.log(`restiq hub listening on 127.0.0.1:${port}`)
  const postStatus = () => {
    if (!parentPort) return
    statusMessage(db, worker, new Date()).then(
      (message) => parentPort.postMessage(message),
      (error: unknown) => console.error('status message failed:', error),
    )
  }
  postStatus()

  const startSync = async (message: DeviceKeyMessage): Promise<void> => {
    const cloudUrl = message.cloudUrl ?? process.env.HUB_CLOUD_URL
    const deviceId = message.deviceId ?? process.env.HUB_DEVICE_ID ?? (await readMeta(db))?.deviceId
    if (worker) return console.warn('sync worker already running; device key ignored')
    if (!cloudUrl || !deviceId) return console.error('sync worker not started: cloudUrl and deviceId are required')
    worker = new SyncWorker({ pg: db, dataDir, cloudUrl, deviceId, key: devicePrivateKey(message.pem), appVersion: message.appVersion ?? 'hub', onTick: postStatus })
    worker.start()
    console.log(`sync worker started for device ${deviceId}`)
    postStatus()
  }

  parent.onDeviceKey((message) => {
    startSync(message).catch((error: unknown) => console.error('sync worker not started:', error))
  })
  const pem = process.env.HUB_DEVICE_KEY_PEM
  if (pem) await startSync({ type: 'device-key', pem })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
