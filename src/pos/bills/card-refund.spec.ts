import { describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import type { ManagerAuthService, RegionRegistryService, StripeService } from '../../platform'
import { BillsService } from './bills.service'

// #284: a card_online credit note on a bill paid by card on the phone refunds through Stripe.
type RefundToCard = (tx: unknown, tenantId: string, billId: string, creditNoteId: string, amountMinor: bigint) => Promise<void>

function setup(payments: Record<string, { amount_received: number; refunded: number; fee?: number }>, refundError?: Error) {
  const tx = {
    paymentIntent: { findMany: vi.fn(() => Promise.resolve(Object.keys(payments).map((providerRef) => ({ providerRef })))) },
    tenantPaymentAccount: { findUnique: vi.fn(() => Promise.resolve({ stripeAccountId: 'acct_1' })) },
  }
  const refundsCreate = vi.fn(() => (refundError ? Promise.reject(refundError) : Promise.resolve({ id: 're_1' })))
  const api = {
    paymentIntents: {
      retrieve: vi.fn((id: string) => Promise.resolve({ id, amount_received: payments[id].amount_received, application_fee_amount: payments[id].fee ?? null, latest_charge: { amount_refunded: payments[id].refunded } })),
    },
    refunds: { create: refundsCreate },
  }
  const service = new BillsService({} as RegionRegistryService, {} as ManagerAuthService, { client: () => api } as unknown as StripeService)
  const refundToCard = (service as unknown as { refundToCard: RefundToCard }).refundToCard.bind(service)
  return { tx, refundsCreate, refund: (amount: bigint) => refundToCard(tx, 'tenant-1', 'bill-1', 'note-1', amount) }
}

describe('card refunds (#284)', () => {
  it('refunds the whole amount from one payment that covers it, keyed by the credit note', async () => {
    const { refundsCreate, refund } = setup({ pi_a: { amount_received: 1000, refunded: 0 }, pi_b: { amount_received: 3000, refunded: 0, fee: 75 } })
    await refund(2500n)
    expect(refundsCreate).toHaveBeenCalledOnce()
    expect(refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_b', amount: 2500, refund_application_fee: true, metadata: { creditNoteId: 'note-1' } },
      { stripeAccount: 'acct_1', idempotencyKey: 'note-1' },
    )
  })

  it('with no platform fee on the payment (fee 0) it does not ask Stripe to refund one - Stripe refuses that', async () => {
    const { refundsCreate, refund } = setup({ pi_a: { amount_received: 550, refunded: 0 } })
    await refund(550n)
    expect(refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_a', amount: 550, metadata: { creditNoteId: 'note-1' } }, { stripeAccount: 'acct_1', idempotencyKey: 'note-1' })
  })

  it('splits over several payments only when one cannot cover it, net of earlier refunds', async () => {
    const { refundsCreate, refund } = setup({ pi_a: { amount_received: 1000, refunded: 400 }, pi_b: { amount_received: 1000, refunded: 0 } })
    await refund(1500n)
    expect(refundsCreate.mock.calls.map((c: unknown[]) => [(c[0] as { payment_intent: string; amount: number }).payment_intent, (c[0] as { amount: number }).amount])).toEqual([
      ['pi_b', 1000],
      ['pi_a', 500],
    ])
  })

  it('502 refund_failed when Stripe refuses or there is not enough left to refund', async () => {
    const refused = setup({ pi_a: { amount_received: 1000, refunded: 0 } }, new Stripe.errors.StripeInvalidRequestError({ message: 'Charge already refunded', type: 'invalid_request_error' }))
    await expect(refused.refund(500n)).rejects.toMatchObject({ status: 502, response: { code: 'refund_failed', message: 'Charge already refunded' } })

    const short = setup({ pi_a: { amount_received: 1000, refunded: 900 } })
    await expect(short.refund(500n)).rejects.toMatchObject({ status: 502, response: { code: 'refund_failed' } })
    expect(short.refundsCreate).not.toHaveBeenCalled()
  })

  it('does nothing for a bill with no Stripe card payment', async () => {
    const { refundsCreate, refund } = setup({})
    await refund(500n)
    expect(refundsCreate).not.toHaveBeenCalled()
  })
})
