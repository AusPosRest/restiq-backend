// #282: Stripe webhook (platform account). Public by path - no realm guard covers
// /webhooks/* - and trusted only through the signature over the raw body.
import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { StripeService } from '../../platform'
import { ReaderOrdersService } from '../card-readers/reader-orders.service'
import { SubscriptionsService } from './subscriptions.service'

@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeService,
    private readonly subscriptions: SubscriptionsService,
    private readonly readerOrders: ReaderOrdersService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined): Promise<{ received: true; result: 'applied' | 'ignored' }> {
    const event = this.stripe.constructEvent(req.rawBody, signature)
    // #286: a reader order's one-off invoice, not a subscription's.
    if ((event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') && event.data.object.metadata?.readerOrderId) {
      return { received: true, result: await this.readerOrders.applyInvoice(event.data.object, event.type === 'invoice.paid') }
    }
    return { received: true, result: await this.subscriptions.applyStripeEvent(event) }
  }
}
