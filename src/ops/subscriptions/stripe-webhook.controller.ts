// #282: Stripe webhook (platform account). Public by path - no realm guard covers
// /webhooks/* - and trusted only through the signature over the raw body.
import { BadRequestException, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import Stripe from 'stripe'
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
    let event: Stripe.Event
    if (!req.rawBody || !signature) throw invalidSignature()
    try {
      event = this.stripe.constructEvent(req.rawBody, signature)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) throw invalidSignature()
      throw error
    }
    return { received: true, result: await this.subscriptions.applyStripeEvent(event) }
  }
}

function invalidSignature(): BadRequestException {
  return new BadRequestException({ code: 'invalid_signature', message: 'Stripe signature check failed' })
}
