// CAP-4's load-bearing read: for a given item (and optionally variant),
// resolve the CURRENT price for a channel/outlet pair. AD-11 makes
// item_prices insert-only, so "current" is never a column - it's always
// derived from the row set. A future-scheduled row (effective_at in the
// future) must never win; a past/omitted effective_at is immediately
// current. Extracted as a pure function (no Prisma) so the tiering logic is
// unit-testable without a database.
import type { Prisma } from '../../generated/prisma/client'
import type { PriceChannel } from '../../generated/prisma/client'

export interface PriceCandidate {
  id: string
  outletId: string | null
  channel: PriceChannel | null
  priceMinor: bigint
  currency: string
  effectiveAt: Date
  createdAt: Date
}

export interface PriceTarget {
  channel: PriceChannel
  outletId: string | null
}

/**
 * Picks the current price from a set of candidate rows for one item/variant.
 * Rules:
 *  - A row scheduled in the future (effectiveAt > asOf) is never eligible.
 *  - A row scoped to a different, non-null outlet/channel than the target is
 *    never eligible - only an exact match or a null (unscoped) row applies.
 *  - Among eligible rows, the most specific wins: an outlet-exact match beats
 *    an outlet-unscoped (null) row; a channel-exact match beats a
 *    channel-unscoped (null) row. Outlet specificity is checked first.
 *  - Ties within the same specificity go to the most recently effective row,
 *    then the most recently created (stable tiebreaker - see AD-11 note in
 *    the workspace conventions about not relying on timestamp order alone).
 */
export function pickCurrentPrice(candidates: readonly PriceCandidate[], target: PriceTarget, asOf: Date = new Date()): PriceCandidate | null {
  let best: PriceCandidate | null = null
  let bestScore = -1

  for (const row of candidates) {
    if (row.effectiveAt.getTime() > asOf.getTime()) continue
    if (row.outletId !== null && row.outletId !== target.outletId) continue
    if (row.channel !== null && row.channel !== target.channel) continue

    const outletScore = row.outletId !== null ? 2 : 0
    const channelScore = row.channel !== null ? 1 : 0
    const score = outletScore + channelScore

    if (
      score > bestScore ||
      (score === bestScore &&
        best !== null &&
        (row.effectiveAt.getTime() > best.effectiveAt.getTime() ||
          (row.effectiveAt.getTime() === best.effectiveAt.getTime() && row.createdAt.getTime() > best.createdAt.getTime())))
    ) {
      best = row
      bestScore = score
    }
  }

  return best
}

/** tx-scoped read: fetches every non-future-eligible-by-time candidate row and resolves the current one. */
export async function resolveCurrentPrice(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; itemId: string; variantId: string | null; channel: PriceChannel; outletId: string | null; asOf?: Date },
): Promise<PriceCandidate | null> {
  const asOf = params.asOf ?? new Date()
  const rows = await tx.itemPrice.findMany({
    where: { tenantId: params.tenantId, itemId: params.itemId, variantId: params.variantId, effectiveAt: { lte: asOf } },
    select: { id: true, outletId: true, channel: true, priceMinor: true, currency: true, effectiveAt: true, createdAt: true },
  })
  return pickCurrentPrice(rows, { channel: params.channel, outletId: params.outletId }, asOf)
}
