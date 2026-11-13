// #284: Stripe Connect webhook - events from restaurants' connected accounts (event.account).
// A separate Stripe endpoint from #282's platform one, with its own signing secret. Public by
// path like /webhooks/stripe, trusted only through the signature over the raw body.
import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { StripeService } from '../../platform'
import { GuestCardPaymentsService } from './card-payments.service'

@Controller('webhooks/stripe/connect')
export class StripeConnectWebhookController {
  constructor(
    private readonly stripe: StripeService,
    private readonly cards: GuestCardPaymentsService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined): Promise<{ received: true; result: 'applied' | 'ignored' }> {
    const event = this.stripe.constructEvent(req.rawBody, signature, 'STRIPE_CONNECT_WEBHOOK_SECRET')
    if (event.account && (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled')) {
      return { received: true, result: await this.cards.applyStripeIntent(event.data.object, event.account) }
    }
    return { received: true, result: 'ignored' }
  }
}
