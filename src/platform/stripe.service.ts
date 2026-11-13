// #282: one Stripe client for the platform account (Connect + subscription billing).
// Built on first use from STRIPE_SECRET_KEY; without a key every Stripe-backed
// route answers 503 payments_not_configured instead of failing at boot.
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common'
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

  /**
   * Verifies a webhook delivery against its endpoint's signing secret (#282 platform: STRIPE_WEBHOOK_SECRET;
   * #284 Connect: STRIPE_CONNECT_WEBHOOK_SECRET). 400 invalid_signature on a bad or missing signature.
   */
  constructEvent(rawBody: Buffer | undefined, signature: string | undefined, secretName: 'STRIPE_WEBHOOK_SECRET' | 'STRIPE_CONNECT_WEBHOOK_SECRET' = 'STRIPE_WEBHOOK_SECRET'): Stripe.Event {
    const secret = process.env[secretName]
    if (!secret) throw notConfigured()
    if (!rawBody || !signature) throw invalidSignature()
    try {
      return this.client().webhooks.constructEvent(rawBody, signature, secret)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) throw invalidSignature()
      throw error
    }
  }
}

function invalidSignature(): BadRequestException {
  return new BadRequestException({ code: 'invalid_signature', message: 'Stripe signature check failed' })
}
