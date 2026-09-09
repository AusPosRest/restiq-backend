// Payments, first slice (issue #130 / epic #129): the simulated card
// terminal. staffId/tenantId/outletId never come from the body (AD-5) - the
// bill's outlet and the signed-in staff are the only sources.
import { IsIn, IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator'
import type { PaymentIntentStatus, PaymentProviderKind, PaymentRail } from '../../generated/prisma/client'

// Only the terminal rail exists yet. upi_qr / upi_intent / card_online
// arrive with their providers (epic #129 B2-B5) - adding a rail here is the
// whole change on this side; the model already carries all four.
export const INTENT_RAILS = ['card_terminal'] as const

export class CreatePaymentIntentDto {
  @IsIn(INTENT_RAILS)
  rail!: PaymentRail

  // Server-validated against what is still due on the bill; a zero or
  // negative amount is not a payment.
  @IsInt() @Min(1)
  amountMinor!: number

  // Client-generated idempotency key: a retried POST with the same key
  // returns the same intent (200) instead of charging twice.
  @IsString() @MinLength(1) @MaxLength(128)
  clientKey!: string
}

export const SIMULATED_OUTCOMES = ['success', 'failure'] as const
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number]

// The simulated provider's "webhook" (ADR-004): what the /pos/terminal
// screen posts when its Approve / Decline is tapped. 404 on any other
// provider - a real rail's outcome is never the caller's to pick.
export class SimulateIntentDto {
  @IsIn(SIMULATED_OUTCOMES)
  outcome!: SimulatedOutcome
}

// Wire shape shared with restiq-web's src/lib/payment-intent.ts
// (PaymentIntentView) - keep the two in step.
export interface PaymentIntentView {
  id: string
  billId: string
  shareGuestId: string | null
  rail: PaymentRail
  provider: PaymentProviderKind
  amountMinor: number
  currency: string
  status: PaymentIntentStatus
  failureReason: string | null
  providerRef: string | null
  client: { simulated?: boolean }
  createdAt: string
  expiresAt: string
  succeededAt: string | null
  tenderId: string | null
}
