import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { accountStatus } from './payments.service'

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
