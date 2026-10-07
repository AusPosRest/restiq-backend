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

  it('only enforces in production', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'development' })).not.toThrow()
    expect(() => assertProductionConfig({ NODE_ENV: 'production' })).toThrow(/Refusing to start/)
  })
})
