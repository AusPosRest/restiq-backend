// restiq-backend#209 (SE-31): Prisma writes UTC wall-clock time, so a database whose
// default TimeZone isn't UTC (e.g. Asia/Kolkata) stored every Prisma timestamp
// hours off from SQL now(). The connection pins its session to UTC.
import { afterAll, describe, expect, it } from 'vitest'
import { createPrismaClient } from '../src/db/client'

describe('database session time zone (e2e)', () => {
  const prisma = createPrismaClient()
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('runs every session in UTC, so Prisma-written and SQL now() timestamps agree', async () => {
    const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
    expect(tz).toBe('UTC')

    await prisma.authAttempt.create({ data: { key: 'tz-probe', attempts: 1, windowStartedAt: new Date() } })
    const [{ drift }] = await prisma.$queryRaw<{ drift: number }[]>`SELECT abs(extract(epoch FROM (now() - window_started_at)))::float AS drift FROM auth_attempts WHERE key = 'tz-probe'`
    expect(drift).toBeLessThan(60)
  })
})
