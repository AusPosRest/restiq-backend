import { afterEach, describe, expect, it } from 'vitest'
import { resolveClientIp } from './client-ip'

const req = (headers: Record<string, string>) => ({ ip: '10.0.0.1', headers })

describe('resolveClientIp (#171)', () => {
  afterEach(() => {
    delete process.env.PROXY_SHARED_SECRET
  })

  it('believes the forwarded address only with the right proxy secret', () => {
    process.env.PROXY_SHARED_SECRET = 's3cret-value'
    expect(resolveClientIp(req({ 'x-restiq-client-ip': '203.0.113.9', 'x-restiq-proxy-secret': 's3cret-value' }))).toBe('203.0.113.9')
    expect(resolveClientIp(req({ 'x-restiq-client-ip': '203.0.113.9', 'x-restiq-proxy-secret': 'wrong-value!' }))).toBe('10.0.0.1')
    expect(resolveClientIp(req({ 'x-restiq-client-ip': '203.0.113.9' }))).toBe('10.0.0.1')
    expect(resolveClientIp(req({ 'x-restiq-client-ip': 'not-an-ip', 'x-restiq-proxy-secret': 's3cret-value' }))).toBe('10.0.0.1')
  })

  it('ignores the header entirely when no secret is configured', () => {
    expect(resolveClientIp(req({ 'x-restiq-client-ip': '203.0.113.9', 'x-restiq-proxy-secret': '' }))).toBe('10.0.0.1')
  })
})
