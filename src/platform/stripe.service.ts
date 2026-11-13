// #282: one Stripe client for the platform account (Connect + subscription billing).
// Built on first use from STRIPE_SECRET_KEY; without a key every Stripe-backed
// route answers 503 payments_not_configured instead of failing at boot.
import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import Stripe from 'stripe'

export const STRIPE_API_VERSION = '2026-10-28.endive'

function notConfigured(): ServiceUnavailableException {
  return new ServiceUnavailableException({ code: 'payments_not_configured', message: 'Card payments are not set up on this server' })
}

@Injectable()
export class StripeService {
  private stripe: Stripe | undefined

  client(): Stripe {
    if (this.stripe) return this.stripe
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw notConfigured()
    this.stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION })
    return this.stripe
  }

  /** Verifies a webhook delivery against STRIPE_WEBHOOK_SECRET; throws Stripe's signature error on a bad one. */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw notConfigured()
    return this.client().webhooks.constructEvent(rawBody, signature, secret)
  }
}
