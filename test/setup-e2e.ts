// e2e runs against the TEST database only - it wipes tables between runs and
// must never touch dev data (see restiq-design/setup/01-dev-environment.md).
import 'dotenv/config'

const testUrl = process.env.TEST_DATABASE_URL
if (!testUrl) {
  throw new Error('TEST_DATABASE_URL is not set - see .env.example')
}
process.env.DATABASE_URL = testUrl
process.env.OPS_JWT_SECRET ??= 'e2e-ops-secret'
process.env.ADMIN_JWT_SECRET ??= 'e2e-admin-secret'
process.env.POS_JWT_SECRET ??= 'e2e-pos-secret'
