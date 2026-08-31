// Applies migrations to the TEST database before the e2e suite runs. A
// separate script because `prisma migrate deploy` reads DATABASE_URL via
// prisma.config.ts, and the test database must never be confused with dev.
import 'dotenv/config'
import { execFileSync } from 'node:child_process'

const url = process.env.TEST_DATABASE_URL
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set - see .env.example')
}

execFileSync('prisma', ['migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
})
