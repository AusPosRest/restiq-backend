// Hub mode entrypoint (#293): the backend's own POS and kitchen code on an
// in-process PGlite store, for the Windows hub till (HUB-BUILD-PLAN §2).
// Listens on 127.0.0.1 only and sends no CORS headers - the local Next server
// is the only caller. Env: HUB_DATA_DIR, HUB_PORT (default 8180), POS_JWT_SECRET.
import 'reflect-metadata'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setPrismaClient } from '../db/client'
import { createHubApp } from './hub.module'
import { openStore } from './store'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function main(): Promise<void> {
  const dataDir = required('HUB_DATA_DIR')
  required('POS_JWT_SECRET')
  const port = Number(process.env.HUB_PORT ?? 8180)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('HUB_PORT must be a port number')
  // The hub never talks to Stripe: without a key every Stripe call answers 503 payments_not_configured.
  delete process.env.STRIPE_SECRET_KEY

  // Bundled: dist-hub/migrations next to hub.cjs. Unbundled (dist/hub/hub-main.js): the repo's prisma/migrations.
  const migrationsDir = [join(__dirname, 'migrations'), join(__dirname, '..', '..', 'prisma', 'migrations')].find((dir) => existsSync(dir))
  if (!migrationsDir) throw new Error('No migrations directory found next to the hub')

  const { prisma } = await openStore(dataDir, migrationsDir)
  setPrismaClient(prisma)
  const app = await createHubApp()
  app.enableShutdownHooks()
  await app.listen(port, '127.0.0.1')
  console.log(`restiq hub listening on 127.0.0.1:${port}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
