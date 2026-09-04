// The e2e suite wipes and reseeds every table across 40 spec files against
// ONE test database (see setup-e2e.ts, and every spec file's wipe()). That's
// safe for a single sequential `vitest run`, but a second, uncoordinated
// `pnpm run test:e2e` invocation against the SAME TEST_DATABASE_URL - a
// second terminal, another worktree still pointed at the same db name, a
// stray background run - interleaves its own wipe()/create() calls with
// ours. Neither run is "wrong"; they're just racing DELETE/INSERT against
// shared rows, which surfaces as FK-restrict errors or assertion mismatches
// in whichever files happen to be running at the moment - a different file
// each time (issue #100). A session-scoped Postgres advisory lock, held for
// the whole run, turns that silent cross-run corruption into an immediate,
// legible failure instead.
import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'

// hashtext() so the lock key is legible in pg_locks rather than a bare magic
// number; any e2e run against the same database contends for this one key.
const LOCK_KEY_SQL = `hashtext('restiq-e2e-suite')::bigint`

export default async function setup(): Promise<() => Promise<void>> {
  const testUrl = process.env.TEST_DATABASE_URL
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set - see .env.example')
  }

  // A dedicated single, never-idle-evicted connection: pg_advisory_lock is
  // session-scoped, so the lock must live on the exact connection we lock
  // and unlock with, not a pool that might hand later queries a different one.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testUrl, max: 1, idleTimeoutMillis: 0 }),
  })

  const [{ locked }] = await prisma.$queryRawUnsafe<[{ locked: boolean }]>(
    `SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS locked`,
  )
  if (!locked) {
    await prisma.$disconnect()
    throw new Error(
      `Another e2e run already holds the lock on TEST_DATABASE_URL=${testUrl}. ` +
        'Wait for it to finish, or point TEST_DATABASE_URL at a different database (see .env.example).',
    )
  }

  return async () => {
    await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`)
    await prisma.$disconnect()
  }
}
