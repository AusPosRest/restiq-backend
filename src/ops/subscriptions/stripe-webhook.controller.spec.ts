import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { StripeService } from '../../platform'
import { StripeWebhookController } from './stripe-webhook.controller'
import type { SubscriptionsService } from './subscriptions.service'

const SECRET = 'whsec_unit_test'

describe('StripeWebhookController', () => {
  const saved = { key: process.env.STRIPE_SECRET_KEY, secret: process.env.STRIPE_WEBHOOK_SECRET }
  const apply = vi.fn<(event: Stripe.Event) => Promise<'applied'>>(() => Promise.resolve('applied'))
  const controller = new StripeWebhookController(new StripeService(), { applyStripeEvent: apply } as unknown as SubscriptionsService)
  const body = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', data: { object: {} } })
  const req = (raw: string | undefined) => ({ rawBody: raw === undefined ? undefined : Buffer.from(raw) }) as RawBodyRequest<Request>

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
    process.env.STRIPE_WEBHOOK_SECRET = SECRET
    apply.mockClear()
  })
  afterEach(() => {
    for (const [name, value] of [['STRIPE_SECRET_KEY', saved.key], ['STRIPE_WEBHOOK_SECRET', saved.secret]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('passes a correctly signed event to the subscriptions service', async () => {
    const signature = new Stripe('sk_test_unit').webhooks.generateTestHeaderString({ payload: body, secret: SECRET })
    await expect(controller.receive(req(body), signature)).resolves.toEqual({ received: true, result: 'applied' })
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_1', type: 'invoice.paid' }))
  })

  it('400s a bad, missing or tampered signature', async () => {
    const signature = new Stripe('sk_test_unit').webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_other' })
    await expect(controller.receive(req(body), signature)).rejects.toMatchObject({ status: 400 })
    await expect(controller.receive(req(body), undefined)).rejects.toMatchObject({ status: 400 })
    await expect(controller.receive(req(undefined), signature)).rejects.toMatchObject({ status: 400 })
    expect(apply).not.toHaveBeenCalled()
  })

  it('503s when the webhook secret is not configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    await expect(controller.receive(req(body), 't=1,v1=x')).rejects.toMatchObject({ status: 503 })
  })
})
