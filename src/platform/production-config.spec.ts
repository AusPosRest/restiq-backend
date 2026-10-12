import { describe, expect, it } from 'vitest'
import { assertProductionConfig, productionConfigProblems } from './production-config'

const s = (c: string) => c.repeat(40)
const GOOD = {
  NODE_ENV: 'production',
  HOME_REGION: 'in-mumbai',
  OPS_JWT_SECRET: s('a'),
  ADMIN_JWT_SECRET: s('b'),
  POS_JWT_SECRET: s('c'),
  GUEST_JWT_SECRET: s('d'),
  PROXY_SHARED_SECRET: s('e'),
  PAYMENTS_SIMULATOR: 'off',
  WEB_ORIGIN: 'https://restiq-web.vercel.app',
  MAIL_PROVIDER: 'mailjet',
  MAILJET_API_KEY: 'key',
  MAILJET_API_SECRET: 'secret',
  MAIL_FROM_EMAIL: 'no-reply@idelta.com.au',
}

describe('production config (#175)', () => {
  it('accepts a complete, safe configuration', () => {
    expect(productionConfigProblems(GOOD)).toEqual([])
    expect(() => assertProductionConfig(GOOD)).not.toThrow()
  })

  it('names every problem at once', () => {
    const problems = productionConfigProblems({
      ...GOOD,
      HOME_REGION: undefined,
      POS_JWT_SECRET: 'short',
      GUEST_JWT_SECRET: GOOD.OPS_JWT_SECRET,
      PROXY_SHARED_SECRET: undefined,
      PAYMENTS_SIMULATOR: 'on',
      WEB_ORIGIN: 'http://localhost:3000',
    })
    expect(problems).toHaveLength(6)
    expect(problems.join(' ')).toMatch(/HOME_REGION.*POS_JWT_SECRET.*different.*PROXY_SHARED_SECRET.*PAYMENTS_SIMULATOR.*WEB_ORIGIN/)
  })

  it('requires Mailjet, fully configured: owners reset their password by email (#181)', () => {
    expect(productionConfigProblems({ ...GOOD, MAIL_PROVIDER: 'log' }).join(' ')).toMatch(/MAIL_PROVIDER must be mailjet/)
    expect(productionConfigProblems({ ...GOOD, MAILJET_API_SECRET: undefined, MAIL_FROM_EMAIL: undefined }).join(' ')).toMatch(/MAILJET_API_SECRET.*MAIL_FROM_EMAIL/)
  })

  it('only enforces in production', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'development' })).not.toThrow()
    expect(() => assertProductionConfig({ NODE_ENV: 'production' })).toThrow(/Refusing to start/)
  })
})
