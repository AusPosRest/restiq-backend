// hub-main's startup without the listen and the sync worker (#306): open or
// rebuild the store, compact the journal, build the app, reconcile. Shared by
// src/hub/recovery.spec.ts and the child process it kills (hub-sale-loop.ts).
import type { PGlite } from '@electric-sql/pglite'
import type { INestApplication } from '@nestjs/common'
import { setPrismaClient } from '../src/db/client'
import { createHubApp } from '../src/hub/hub.module'
import { compactJournal } from '../src/hub/journal'
import { openOrRebuild, reconcile } from '../src/hub/recovery'

export async function bootHub(dataDir: string, migrationsDir: string): Promise<{ pg: PGlite; app: INestApplication }> {
  const { pg, prisma } = await openOrRebuild(dataDir, migrationsDir)
  compactJournal(dataDir)
  setPrismaClient(prisma)
  const app = await createHubApp(pg, dataDir)
  await reconcile(app, pg, dataDir)
  await app.init()
  return { pg, app }
}
