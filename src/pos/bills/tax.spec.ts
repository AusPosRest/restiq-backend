import { describe, expect, it } from 'vitest'
import { computeTax } from './tax'

function sumBreakdown(breakdown: { amountMinor: bigint }[]): bigint {
  return breakdown.reduce((sum, line) => sum + line.amountMinor, 0n)
}

describe('computeTax', () => {
  it('IN + CGST/SGST profile: splits 5% into 2.5% CGST + 2.5% SGST, summing to taxMinor', () => {
    const result = computeTax({
      country: 'IN',
      gstRegistered: true,
      taxProfile: 'India GST - CGST/SGST split',
      compositionScheme: false,
      subtotalMinor: 20000n,
    })
    expect(result.pricesIncludeTax).toBe(false)
    expect(result.taxMinor).toBe(1000n)
    expect(result.breakdown).toEqual([
      { label: 'CGST', ratePercent: 2.5, amountMinor: 500n },
      { label: 'SGST', ratePercent: 2.5, amountMinor: 500n },
    ])
    expect(sumBreakdown(result.breakdown)).toBe(result.taxMinor)
    expect(result.notes).toEqual([])
  })

  it('IN with no recognizable profile (e.g. a tenant with no tax registration row) defaults to the CGST/SGST split', () => {
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 20000n })
    expect(result.taxMinor).toBe(1000n)
    expect(result.breakdown.map((l) => l.label)).toEqual(['CGST', 'SGST'])
  })

  it('IN + IGST profile: a single 5% IGST line', () => {
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'Interstate - IGST', compositionScheme: false, subtotalMinor: 20000n })
    expect(result.pricesIncludeTax).toBe(false)
    expect(result.taxMinor).toBe(1000n)
    expect(result.breakdown).toEqual([{ label: 'IGST', ratePercent: 5, amountMinor: 1000n }])
    expect(sumBreakdown(result.breakdown)).toBe(result.taxMinor)
  })

  it('IGST match is case-insensitive', () => {
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'igst', compositionScheme: false, subtotalMinor: 10000n })
    expect(result.breakdown[0]?.label).toBe('IGST')
  })

  it('IN + compositionScheme: zero tax, empty breakdown, the statutory note - even for an otherwise-IGST profile', () => {
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'IGST', compositionScheme: true, subtotalMinor: 20000n })
    expect(result.taxMinor).toBe(0n)
    expect(result.pricesIncludeTax).toBe(false)
    expect(result.breakdown).toEqual([])
    expect(result.notes).toEqual(['Composition taxable person, not eligible to collect tax on supplies'])
  })

  it('AU: single inclusive 10% GST line, tax backed out of the subtotal', () => {
    const result = computeTax({ country: 'AU', gstRegistered: true, taxProfile: 'Australia GST', compositionScheme: false, subtotalMinor: 11000n })
    expect(result.pricesIncludeTax).toBe(true)
    expect(result.taxMinor).toBe(1000n) // 11000 - round(11000*10/11) = 11000 - 10000
    expect(result.breakdown).toEqual([{ label: 'GST', ratePercent: 10, amountMinor: 1000n }])
    expect(sumBreakdown(result.breakdown)).toBe(result.taxMinor)
  })

  it('AU + gstRegistered=false: zero-tax receipt path, no GST in subtotal', () => {
    const result = computeTax({ country: 'AU', gstRegistered: false, taxProfile: 'Australia GST', compositionScheme: false, subtotalMinor: 11000n })
    expect(result.pricesIncludeTax).toBe(false)
    expect(result.taxMinor).toBe(0n)
    expect(result.breakdown).toEqual([])
    expect(result.notes).toEqual(['Not registered for GST - this is a receipt, not a tax invoice'])
  })

  it('IN: ignores gstRegistered=false and computes GST as if gstRegistered were true', () => {
    const result = computeTax({
      country: 'IN',
      gstRegistered: false,
      taxProfile: 'India GST - CGST/SGST split',
      compositionScheme: false,
      subtotalMinor: 20000n,
    })
    expect(result.pricesIncludeTax).toBe(false)
    expect(result.taxMinor).toBe(1000n)
    expect(result.breakdown.map((line) => line.label)).toEqual(['CGST', 'SGST'])
    expect(result.notes).toEqual([])
  })

  it('AU: compositionScheme is an IN-only concept and has no effect', () => {
    const withComposition = computeTax({
      country: 'AU',
      gstRegistered: true,
      taxProfile: 'Australia GST',
      compositionScheme: true,
      subtotalMinor: 11000n,
    })
    expect(withComposition.taxMinor).toBe(1000n)
    expect(withComposition.notes).toEqual([])
  })

  it('rounding: IN CGST/SGST on a subtotal where the two lines round to the same figure', () => {
    // 30 * 5% = 1.5 -> round-half-up 2; 30 * 2.5% = 0.75 -> round-half-up 1; SGST absorbs the remainder (1).
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 30n })
    expect(result.taxMinor).toBe(2n)
    expect(result.breakdown).toEqual([
      { label: 'CGST', ratePercent: 2.5, amountMinor: 1n },
      { label: 'SGST', ratePercent: 2.5, amountMinor: 1n },
    ])
  })

  it('rounding: IN CGST/SGST where CGST alone would round up to more than half of taxMinor, SGST still comes out non-negative', () => {
    // 10 * 2.5% = 0.25 -> round-half-up 0; 10 * 5% = 0.5 -> round-half-up 1; SGST = 1 - 0 = 1.
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 10n })
    expect(result.taxMinor).toBe(1n)
    expect(result.breakdown).toEqual([
      { label: 'CGST', ratePercent: 2.5, amountMinor: 0n },
      { label: 'SGST', ratePercent: 2.5, amountMinor: 1n },
    ])
  })

  it('rounding: IGST rounds half up at the 5% boundary', () => {
    // 10 * 5% = 0.5 -> round-half-up 1.
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'IGST', compositionScheme: false, subtotalMinor: 10n })
    expect(result.taxMinor).toBe(1n)
  })

  it('rounding: AU GST on a subtotal not evenly divisible by 11', () => {
    // 100 * 10/11 = 90.909... -> round-half-up 91; tax = 100 - 91 = 9.
    const result = computeTax({ country: 'AU', gstRegistered: true, taxProfile: 'GST', compositionScheme: false, subtotalMinor: 100n })
    expect(result.taxMinor).toBe(9n)
  })

  it('zero subtotal produces zero tax in every branch', () => {
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'IGST', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: true, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'AU', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'AU', gstRegistered: false, taxProfile: '', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
  })
})
