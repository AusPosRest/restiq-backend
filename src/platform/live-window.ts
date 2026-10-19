/**
 * CU-20 / restiq-backend#230: how far back "live" reaches. A ticket fired, or
 * an unclosed order opened, more than 12 hours ago is a leftover from an
 * earlier service - it stays in the data but no longer counts as live work:
 * off the KDS boards, and no longer marks its table busy or occupied.
 */
import type { Prisma } from '../generated/prisma/client'

export const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000

export const liveSince = (): Date => new Date(Date.now() - LIVE_WINDOW_MS)

/**
 * #230 (Q26): before a new order is placed on a table, an unclosed order left
 * on it from before the live window is moved off the table (table_id null) so
 * orders_one_active_per_table lets the new one in. Its status and lines are
 * untouched and it stays in Open orders for End of day (#251) to close.
 * Audited in the caller's transaction.
 */
export async function detachStaleTableOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tableId: string,
  actor: { actorId: string | null; actorEmail: string },
): Promise<void> {
  const stale = await tx.order.findFirst({ where: { tenantId, tableId, status: { not: 'closed' }, createdAt: { lt: liveSince() } }, select: { id: true } })
  if (!stale) return
  await tx.order.update({ where: { id: stale.id }, data: { tableId: null } })
  await tx.auditEvent.create({
    data: {
      tenantId,
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      action: 'order.detached_stale_table',
      reason: `Order ${stale.id} open over 12 hours moved off table ${tableId}`,
      occurredAt: new Date(),
    },
  })
}
