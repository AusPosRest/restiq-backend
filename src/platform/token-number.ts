import type { Prisma } from '../generated/prisma/client'
import { uuidv7 } from './uuidv7'

/**
 * Reserves the next token number for an outlet inside the caller's transaction
 * (so a failed order never burns one). The counter row can fall behind orders
 * that already hold a token (imported or seeded data), which made the unique
 * (tenant, outlet, token) index fail with a 500 on every try - so the new
 * number is always above both the counter and the highest token in use.
 */
export async function reserveTokenNumber(tx: Prisma.TransactionClient, tenantId: string, outletId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO token_number_counters (id, tenant_id, outlet_id, last_number)
    VALUES (${uuidv7()}::uuid, ${tenantId}::uuid, ${outletId}::uuid,
            1 + (SELECT COALESCE(MAX(token_number), 0) FROM orders WHERE outlet_id = ${outletId}::uuid))
    ON CONFLICT (outlet_id) DO UPDATE SET last_number =
      GREATEST(token_number_counters.last_number, (SELECT COALESCE(MAX(token_number), 0) FROM orders WHERE outlet_id = ${outletId}::uuid)) + 1
    RETURNING last_number`
  return rows[0].last_number
}
