// CAP-4 success criterion: "current price" never returns a future-scheduled
// row, and prefers the most specific outlet/channel match among eligible
// rows. Pure-function tests - no database needed for the tiering logic.
import { describe, expect, it } from 'vitest'
import { pickCurrentPrice, type PriceCandidate } from './pricing'

const NOW = new Date('2026-08-24T12:00:00Z')
const YESTERDAY = new Date('2026-08-23T12:00:00Z')
const TOMORROW = new Date('2026-08-25T12:00:00Z')

function row(overrides: Partial<PriceCandidate>): PriceCandidate {
  return {
    id: 'row',
    outletId: null,
    channel: null,
    priceMinor: 10000n,
    currency: 'INR',
    effectiveAt: YESTERDAY,
    createdAt: YESTERDAY,
    ...overrides,
  }
}

describe('pickCurrentPrice', () => {
  it('returns null when there are no candidates', () => {
    expect(pickCurrentPrice([], { channel: 'dine_in', outletId: null }, NOW)).toBeNull()
  })

  it('excludes a future-scheduled row even if it is the only candidate', () => {
    const future = row({ id: 'future', effectiveAt: TOMORROW })
    expect(pickCurrentPrice([future], { channel: 'dine_in', outletId: null }, NOW)).toBeNull()
  })

  it('picks the unscoped (channel/outlet null) row when nothing more specific exists', () => {
    const base = row({ id: 'base' })
    expect(pickCurrentPrice([base], { channel: 'delivery', outletId: 'outlet-1' }, NOW)?.id).toBe('base')
  })

  it('prefers a channel-specific row over the unscoped default', () => {
    const base = row({ id: 'base' })
    const channelRow = row({ id: 'channel', channel: 'delivery' })
    const result = pickCurrentPrice([base, channelRow], { channel: 'delivery', outletId: null }, NOW)
    expect(result?.id).toBe('channel')
  })

  it('excludes a row scoped to a different, non-null channel', () => {
    const wrongChannel = row({ id: 'wrong', channel: 'takeaway' })
    expect(pickCurrentPrice([wrongChannel], { channel: 'delivery', outletId: null }, NOW)).toBeNull()
  })

  it('prefers an outlet-specific row over a tenant-wide row for the same channel', () => {
    const tenantWide = row({ id: 'tenant-wide', channel: 'dine_in' })
    const outletRow = row({ id: 'outlet', channel: 'dine_in', outletId: 'outlet-1' })
    const result = pickCurrentPrice([tenantWide, outletRow], { channel: 'dine_in', outletId: 'outlet-1' }, NOW)
    expect(result?.id).toBe('outlet')
  })

  it('falls back to the tenant-wide row for an outlet with no override', () => {
    const tenantWide = row({ id: 'tenant-wide', channel: 'dine_in' })
    const otherOutlet = row({ id: 'other-outlet', channel: 'dine_in', outletId: 'outlet-2' })
    const result = pickCurrentPrice([tenantWide, otherOutlet], { channel: 'dine_in', outletId: 'outlet-1' }, NOW)
    expect(result?.id).toBe('tenant-wide')
  })

  it('outlet specificity outranks channel specificity', () => {
    // outlet-exact + channel-null beats outlet-null + channel-exact.
    const channelOnly = row({ id: 'channel-only', channel: 'dine_in' })
    const outletOnly = row({ id: 'outlet-only', outletId: 'outlet-1' })
    const result = pickCurrentPrice([channelOnly, outletOnly], { channel: 'dine_in', outletId: 'outlet-1' }, NOW)
    expect(result?.id).toBe('outlet-only')
  })

  it('among rows at the same specificity, picks the most recently effective one', () => {
    const older = row({ id: 'older', effectiveAt: new Date('2026-08-20T00:00:00Z') })
    const newer = row({ id: 'newer', effectiveAt: YESTERDAY })
    const result = pickCurrentPrice([older, newer], { channel: 'dine_in', outletId: null }, NOW)
    expect(result?.id).toBe('newer')
  })

  it('a past-effective row still counts as immediate - "null/past effective_at means immediate"', () => {
    const longAgo = row({ id: 'long-ago', effectiveAt: new Date('2020-01-01T00:00:00Z') })
    expect(pickCurrentPrice([longAgo], { channel: 'dine_in', outletId: null }, NOW)?.id).toBe('long-ago')
  })

  it('breaks an effectiveAt tie using createdAt', () => {
    const first = row({ id: 'first', effectiveAt: YESTERDAY, createdAt: YESTERDAY })
    const second = row({ id: 'second', effectiveAt: YESTERDAY, createdAt: NOW })
    const result = pickCurrentPrice([first, second], { channel: 'dine_in', outletId: null }, NOW)
    expect(result?.id).toBe('second')
  })
})
