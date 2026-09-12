// Device topology (issue #134): a printer or card terminal linked to a POS
// (devices.paired_pos_id) serves only that POS; unlinked ones keep serving
// the whole outlet. Print jobs and payment intents carry target_device_id =
// the linked peripheral, or null for the outlet-wide queue.
import type { Prisma } from '../generated/prisma/client'

export type PeripheralType = 'printer' | 'terminal'

/** Where work sent from this POS tab goes: its active linked printer/terminal, or null (outlet-wide). A missing, foreign or non-POS source routes outlet-wide. */
export async function linkedPeripheral(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sourcePosId: string | undefined,
  type: PeripheralType,
): Promise<string | null> {
  if (!sourcePosId) return null
  const peripheral = await tx.device.findFirst({
    where: { tenantId, type, status: 'active', pairedPosId: sourcePosId, pairedPos: { is: { status: 'active', type: 'pos' } } },
    select: { id: true },
  })
  return peripheral?.id ?? null
}

/** Which queue a polling printer/terminal drains: its own id while it is linked to a POS, otherwise null (the outlet-wide queue). */
export async function queueFor(
  tx: Prisma.TransactionClient,
  tenantId: string,
  deviceId: string | undefined,
  type: PeripheralType,
): Promise<string | null> {
  if (!deviceId) return null
  const device = await tx.device.findFirst({
    where: { id: deviceId, tenantId, type, status: 'active', pairedPosId: { not: null } },
    select: { id: true },
  })
  return device?.id ?? null
}
