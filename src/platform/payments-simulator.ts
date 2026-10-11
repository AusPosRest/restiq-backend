// restiq-backend#170: the simulated card terminal approves payments without
// any money moving, so it is off unless PAYMENTS_SIMULATOR=on (local dev,
// demos, e2e). Read on every call rather than at boot so one process can't
// cache a stale answer. Checked in the services - intent creation, the
// simulate webhook, confirmIntent and bill finalisation - not only at a route.
import type { Prisma } from '../generated/prisma/client'
import { tenantInTestMode } from './tenant-mode'

/** The server-wide switch only. Callers that know the tenant should use paymentsSimulatorFor. */
export function paymentsSimulatorEnabled(): boolean {
  return process.env.PAYMENTS_SIMULATOR === 'on'
}

/**
 * restiq-backend#213: simulated payments for one tenant - on when the server switch is on, or when the
 * tenant is in Test mode. A Live tenant on a server with the switch off never gets simulated payments.
 * `tx` must already carry an RLS context that can read the tenant row.
 */
export async function paymentsSimulatorFor(tx: Prisma.TransactionClient, tenantId: string): Promise<boolean> {
  return paymentsSimulatorEnabled() || tenantInTestMode(tx, tenantId)
}
