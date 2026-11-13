import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { accountStatus, detailsSubmitted, doneUrl, requirementTitle, toRequirement } from './payments.service'

type Entry = Stripe.V2.Core.Account.Requirements.Entry

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    awaiting_action_from: 'user',
    description: 'Provide business details',
    errors: [],
    impact: { restricts_capabilities: [] },
    minimum_deadline: { status: 'currently_due' },
    requested_reasons: [{ code: 'routine_onboarding' }],
    ...overrides,
  }
}

function account(cardStatus: string | undefined, entries: Entry[]): Pick<Stripe.V2.Core.Account, 'configuration' | 'requirements'> {
  return {
    configuration: cardStatus ? ({ merchant: { capabilities: { card_payments: { status: cardStatus } } } } as Stripe.V2.Core.Account.Configuration) : undefined,
    requirements: { entries },
  }
}

describe('accountStatus', () => {
  it('no account is not_connected', () => {
    expect(accountStatus(null)).toEqual({ status: 'not_connected', requirementsDue: 0 })
  })

  it('active card payments is active, whatever else is outstanding', () => {
    expect(accountStatus(account('active', [entry({ requested_reasons: [{ code: 'routine_verification' }] })]))).toEqual({ status: 'active', requirementsDue: 1 })
  })

  it('only routine first-time requirements owed by the owner is onboarding', () => {
    expect(accountStatus(account('pending', [entry(), entry()]))).toEqual({ status: 'onboarding', requirementsDue: 2 })
  })

  it('a submitted form under review, rejected details or extra verification is restricted', () => {
    expect(accountStatus(account('pending', [entry({ awaiting_action_from: 'stripe' })])).status).toBe('restricted')
    expect(accountStatus(account('restricted', [entry({ errors: [{ code: 'invalid_tax_id', description: 'bad' }] })])).status).toBe('restricted')
    expect(accountStatus(account('restricted', [entry({ requested_reasons: [{ code: 'routine_verification' }] })])).status).toBe('restricted')
  })

  it('not active with nothing outstanding is restricted', () => {
    expect(accountStatus(account('pending', []))).toEqual({ status: 'restricted', requirementsDue: 0 })
    expect(accountStatus(account(undefined, []))).toEqual({ status: 'restricted', requirementsDue: 0 })
  })
})

describe('toRequirement', () => {
  it('maps a real Stripe verification entry', () => {
    const e = entry({
      description: 'identity.individual.documents.primary_verification',
      minimum_deadline: { status: 'past_due' },
      errors: [{ code: 'verification_failed_keyed_identity', description: 'Could not be verified.' }],
      impact: {
        restricts_capabilities: [
          { capability: 'card_payments', configuration: 'merchant', deadline: { status: 'currently_due' } },
          { capability: 'stripe_balance.payouts', configuration: 'merchant', deadline: { status: 'currently_due' } },
        ],
      },
    })
    expect(toRequirement(e)).toEqual({
      code: 'identity.individual.documents.primary_verification',
      title: 'Identity document',
      problem: 'Could not be verified.',
      urgency: 'past_due',
      blocks: ['card_payments', 'payouts'],
      waitingOn: 'owner',
    })
  })

  it('defaults to eventually_due, no problem, waiting on stripe', () => {
    expect(toRequirement(entry({ minimum_deadline: { status: 'some_future' } as never, awaiting_action_from: 'stripe' }))).toMatchObject({
      urgency: 'eventually_due',
      problem: null,
      blocks: [],
      waitingOn: 'stripe',
    })
  })
})

describe('requirementTitle', () => {
  it.each([
    ['identity.individual.documents.primary_verification', 'Identity document'],
    ['identity.individual.dob', "Owner's personal details"],
    ['identity.business_profile.url', 'Business details'],
    ['identity.business_details.registration_number', 'Company details'],
    ['identity.company.tax_id', 'Company details'],
    ['external_account', 'Bank account for payouts'],
    ['tos_acceptance', "Accept Stripe's terms"],
    ['identity.attestations.directors_provided', 'Owners and directors'],
    ['some.odd_thing_here', 'Some odd thing here'],
  ])('%s -> %s', (code, title) => expect(requirementTitle(code)).toBe(title))
})

describe('detailsSubmitted', () => {
  it('is false with no account or only routine onboarding entries', () => {
    expect(detailsSubmitted(null)).toBe(false)
    expect(detailsSubmitted(account('pending', [entry()]))).toBe(false)
  })
  it('is true once an entry is not routine onboarding, there are none, or card is active', () => {
    expect(detailsSubmitted(account('pending', [entry({ requested_reasons: [{ code: 'routine_verification' }] })]))).toBe(true)
    expect(detailsSubmitted(account('pending', []))).toBe(true)
    expect(detailsSubmitted(account('active', [entry()]))).toBe(true)
  })
})

describe('doneUrl', () => {
  it('carries flow, tenant and slug', () => {
    process.env.WEB_ORIGIN = 'https://web.test'
    expect(doneUrl({ id: 't1', slug: 'cafe' }, 'onboarding')).toBe('https://web.test/stripe/done?flow=onboarding&tenant=t1&slug=cafe')
    expect(doneUrl({ id: 't1', slug: null }, 'expired')).toBe('https://web.test/stripe/done?flow=expired&tenant=t1')
  })
})
