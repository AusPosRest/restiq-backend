// qr-self-order/CAP-5 (issue #80). guestId/tenantId/sessionId are never
// accepted from the request body - they come from the signed guest token or
// the URL path, same posture as every other guest DTO (AD-5).
import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator'
import type { BillShareStatus } from '../../generated/prisma/client'
import type { BillView } from '../../pos/bills'

export const SIMULATED_OUTCOMES = ['success', 'failure'] as const
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number]

// The simulated-payment affordance (SPEC qr-self-order CAP-5, AD-17/AD-18's
// "no real payment integration" non-goal): a real UPI/PSP integration would
// never let the caller pick its own outcome - this field name and the
// service-side comment on payShare()/payAll() below both say so explicitly,
// the same demo-marked-honesty posture pos/CAP-11's printer status uses.
export class SimulatedPaymentDto {
  @IsIn(SIMULATED_OUTCOMES)
  simulatedOutcome!: SimulatedOutcome

  // FR-42: phone captured at payment only - optional, no validation theater
  // (a guest may simply decline to give one).
  @IsOptional() @IsString() @MinLength(1)
  payerPhone?: string
}

export interface BillShareView {
  guestId: string
  guestName: string
  amountMinor: number
  status: BillShareStatus
  payerPhone: string | null
  paidAt: string | null
}

// #284: the same three ops can allow (ops/payments' PAYMENT_METHODS - not imported across modules, AD-2).
export const CARD_PAYMENT_METHODS = ['card', 'apple_pay', 'google_pay'] as const

/** #284: what the phone needs for Stripe's Payment Element - null when card payments aren't on here. */
export interface CardPaymentsView {
  provider: 'stripe'
  publishableKey: string
  /** The restaurant's connected account - loadStripe(publishableKey, { stripeAccount }). */
  stripeAccountId: string
  /** Always includes 'card'. */
  allowedMethods: Array<(typeof CARD_PAYMENT_METHODS)[number]>
}

/** #284 POST bills/:id/card-payment - guestId pays that guest's share; omitted pays the whole bill (pay-all's rule). */
export class StartCardPaymentDto {
  @IsOptional() @IsUUID()
  guestId?: string

  @IsOptional() @IsString() @MinLength(1)
  payerPhone?: string
}

export interface CardPaymentStartView {
  intentId: string
  clientSecret: string
  amountMinor: number
  currency: 'AUD' | 'INR'
}

export interface GuestBillView extends BillView {
  shares: BillShareView[]
  cardPayments: CardPaymentsView | null
  /** restiq-backend#278: false when this tenant can't take payment from the phone - show "pay at the counter" up front. #284: simulator on, or cardPayments set. */
  paymentsAvailable: boolean
}
