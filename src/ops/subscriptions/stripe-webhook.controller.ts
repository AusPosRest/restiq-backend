// #282: Stripe webhook (platform account). Public by path - no realm guard covers
// /webhooks/* - and trusted only through the signature over the raw body.
import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { StripeService } from '../../platform'
import { SubscriptionsService } from './subscriptions.service'

@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined): Promise<{ received: true; result: 'applied' | 'ignored' }> {
    const event = this.stripe.constructEvent(req.rawBody, signature)
    return { received: true, result: await this.subscriptions.applyStripeEvent(event) }
  }
}
