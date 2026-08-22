// Prisma 7 config - read by the CLI only (migrate, generate, studio). The
// running app never reads this file: src/db/client.ts builds the client from
// DATABASE_URL through the pg driver adapter.
//
// Prefers DIRECT_URL over DATABASE_URL. On Neon those are two different
// strings - pooled for the app, direct for the CLI - because the migrate
// engine holds a Postgres advisory lock across statements, and a transaction
// pooler is free to hand the next statement to a different backend, losing
// the lock. Locally there is one unpooled Postgres and no DIRECT_URL, so the
// fallback is the normal path. See restiq-design/setup/04-prisma-setup.md.
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

const cliUrl = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL']

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: cliUrl },
})
