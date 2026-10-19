// Framework-free intent mechanics (issue #130, epic #129 / ADR-001): the one
// code path that turns a provider-confirmed intent into money on the bill.
// Kept free of NestJS and PosPrincipal, like pos/bills/bill-core.ts, so the
// guest share path (B4) and a real provider's webhook handler (B6) call the
// exact same confirmIntent rather than growing their own.
import type { Prisma } from '../../generated/prisma/client'
import { ConflictException } from '@nestjs/common'
import { paymentsSimulatorFor } from '../../platform'
import { createTenderRecord, lockBill } from '../bills'
import { PaymentIntentView } from './intents.dtos'

type Tx = Prisma.TransactionClient

/** failureReason on a succeeded intent whose capture landed on an already-settled bill - the money must go back (SE-28). */
export const LATE_CAPTURE_REFUND_DUE = 'late_capture_refund_due'

export const ACTIVE_INTENT_STATUSES = ['created', 'pending'] as const

export const INTENT_INCLUDE = { tender: { select: { id: true } } } satisfies Prisma.PaymentIntentInclude
export type IntentRow = Prisma.PaymentIntentGetPayload<{ include: typeof INTENT_INCLUDE }>

export function isIntentActive(intent: Pick<IntentRow, 'status'>): boolean {
  return (ACTIVE_INTENT_STATUSES as readonly string[]).includes(intent.status)
}

export function toPaymentIntentView(intent: IntentRow): PaymentIntentView {
  const client = typeof intent.clientPayload === 'object' && intent.clientPayload !== null && !Array.isArray(intent.clientPayload) ? (intent.clientPayload as { simulated?: boolean }) : {}
  return {
    id: intent.id,
    billId: intent.billId,
    // Guest shares land with B4; a whole-bill intent has no guest.
    shareGuestId: null,
    rail: intent.rail,
    provider: intent.provider,
    amountMinor: Number(intent.amountMinor),
    currency: intent.currency,
    status: intent.status,
    failureReason: intent.failureReason,
    providerRef: intent.providerRef,
    client,
    createdAt: intent.createdAt.toISOString(),
    expiresAt: intent.expiresAt.toISOString(),
    succeededAt: intent.succeededAt?.toISOString() ?? null,
    tenderId: intent.tender?.id ?? null,
  }
}

/**
 * Money moved: flip the intent to succeeded and write its Tender in this
 * same transaction. Compare-and-swap on status (the same discipline as
 * bill-core's commitFinalize) so two concurrent confirmations can only ever
 * write one tender - the loser's updateMany affects zero rows and it simply
 * re-reads the winner's result. `expired` is deliberately in the CAS set
 * (ADR-011): a capture that lands after our clock ran out is still money
 * on the bill, and recording it is not optional - unless the bill was
 * settled meanwhile, in which case it is flagged for a refund instead.
 */
export async function confirmIntent(tx: Tx, params: { tenantId: string; intentId: string }): Promise<IntentRow> {
  // #170: a simulated approval is never money - refuse it whenever the simulator is off, whenever the intent was made.
  const target = await tx.paymentIntent.findUniqueOrThrow({ where: { id: params.intentId }, select: { provider: true, billId: true } })
  // restiq-backend#227 (G2): takes the bill's row lock so a capture racing a cash/other finalize sees locked data.
  await lockBill(tx, target.billId)
  if (target.provider === 'simulated' && !(await paymentsSimulatorFor(tx, params.tenantId))) {
    throw new ConflictException({ code: 'simulator_disabled', message: 'Simulated card payments are turned off' })
  }
  const flipped = await tx.paymentIntent.updateMany({
    where: { id: params.intentId, status: { in: ['created', 'pending', 'expired'] } },
    data: { status: 'succeeded', succeededAt: new Date(), failureReason: null },
  })
  const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: params.intentId }, include: INTENT_INCLUDE })
  if (flipped.count === 0 || intent.tender) return intent

  // restiq-backend#208 (SE-28): a capture that lands after the bill was
  // settled some other way must never become a second tender on a finalised
  // bill (the guest would be charged twice, silently). Record that the money
  // moved, write no tender, and flag it for a refund in the audit trail.
  const bill = await tx.bill.findUniqueOrThrow({ where: { id: intent.billId }, select: { status: true } })
  if (bill.status === 'finalized') {
    await tx.paymentIntent.update({ where: { id: intent.id }, data: { failureReason: LATE_CAPTURE_REFUND_DUE } })
    await tx.auditEvent.create({
      data: {
        tenantId: params.tenantId,
        actorEmail: 'system:payments',
        action: 'payment.late_capture_refund_due',
        reason: `Payment intent ${intent.id} (${intent.amountMinor} ${intent.currency}) was captured after bill ${intent.billId} was already settled - refund it to the customer`,
        occurredAt: new Date(),
      },
    })
    return tx.paymentIntent.findUniqueOrThrow({ where: { id: params.intentId }, include: INTENT_INCLUDE })
  }

  await createTenderRecord(tx, {
    tenantId: params.tenantId,
    billId: intent.billId,
    // PaymentRail and TenderMethod share the four electronic names by design.
    method: intent.rail,
    amountMinor: intent.amountMinor,
    paymentIntentId: intent.id,
  })
  return tx.paymentIntent.findUniqueOrThrow({ where: { id: params.intentId }, include: INTENT_INCLUDE })
}

/** The provider said no (or the terminal declined): terminal, no tender, retryable with a fresh intent. */
export async function failIntent(tx: Tx, intentId: string, reason: string): Promise<IntentRow> {
  await tx.paymentIntent.updateMany({
    where: { id: intentId, status: { in: [...ACTIVE_INTENT_STATUSES] } },
    data: { status: 'failed', failureReason: reason },
  })
  return tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId }, include: INTENT_INCLUDE })
}

/**
 * Lazy expiry on read (ADR-010): the reconcile sweep (B9) is not built yet,
 * so every read path flips an active intent past its expiresAt to expired
 * before returning it. A capture arriving later still lands (see
 * confirmIntent).
 */
export async function expireIfDue(tx: Tx, intent: IntentRow, now = new Date()): Promise<IntentRow> {
  if (!isIntentActive(intent) || intent.expiresAt > now) return intent
  await tx.paymentIntent.updateMany({
    where: { id: intent.id, status: { in: [...ACTIVE_INTENT_STATUSES] } },
    data: { status: 'expired', failureReason: 'timed_out' },
  })
  return tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id }, include: INTENT_INCLUDE })
}
