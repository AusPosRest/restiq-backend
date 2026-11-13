import { describe, expect, it } from 'vitest'
import { computeTax, GstSplitRounding } from './tax'

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

  it('rounding: IN total GST is rounded once, then split CGST = lower half, SGST = remainder (#244)', () => {
    // 30 * 5% = 1.5 -> round-half-up 2; split 1 + 1.
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 30n })
    expect(result.taxMinor).toBe(2n)
    expect(result.breakdown).toEqual([
      { label: 'CGST', ratePercent: 2.5, amountMinor: 1n },
      { label: 'SGST', ratePercent: 2.5, amountMinor: 1n },
    ])
  })

  it('rounding: Rs 289 at 5% is GST 14.45 (7.22 + 7.23), never 14.46 (#244, AP-cu-15)', () => {
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'India GST - CGST/SGST split', compositionScheme: false, subtotalMinor: 28900n })
    expect(result.taxMinor).toBe(1445n)
    expect(result.breakdown).toEqual([
      { label: 'CGST', ratePercent: 2.5, amountMinor: 722n },
      { label: 'SGST', ratePercent: 2.5, amountMinor: 723n },
    ])
    expect(sumBreakdown(result.breakdown)).toBe(result.taxMinor)
  })

  it('rounding: a discounted taxable value with odd-paisa GST still splits to the rounded total (#244)', () => {
    // 52020 * 5% = 2601 -> 1300 + 1301 (rounding each half up gave 2602).
    const result = computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 52020n })
    expect(result.taxMinor).toBe(2601n)
    expect(result.breakdown.map((l) => l.amountMinor)).toEqual([1300n, 1301n])
    expect(sumBreakdown(result.breakdown)).toBe(result.taxMinor)
  })

  it('rounding: a negative taxable value rounds symmetrically, not toward zero (SE-7)', () => {
    // -25000 * 2.5% = -625 per half; IGST -25000 * 5% = -1250 (not -1249).
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: -25000n }).taxMinor).toBe(-1250n)
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'IGST', compositionScheme: false, subtotalMinor: -30n }).taxMinor).toBe(-2n)
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

  it('IN + custom gstRatePercent: splits 12% into 6% CGST + 6% SGST', () => {
    const result = computeTax({
      country: 'IN',
      gstRegistered: true,
      taxProfile: 'India GST - CGST/SGST split',
      compositionScheme: false,
      subtotalMinor: 20000n,
      gstRatePercent: 12,
    })
    expect(result.taxMinor).toBe(2400n)
    expect(result.breakdown).toEqual([
      { label: 'CGST', ratePercent: 6, amountMinor: 1200n },
      { label: 'SGST', ratePercent: 6, amountMinor: 1200n },
    ])
    expect(sumBreakdown(result.breakdown)).toBe(result.taxMinor)
  })

  it('AU + custom gstRatePercent: single inclusive 15% GST line', () => {
    const result = computeTax({
      country: 'AU',
      gstRegistered: true,
      taxProfile: 'Australia GST',
      compositionScheme: false,
      subtotalMinor: 11500n,
      gstRatePercent: 15,
    })
    expect(result.pricesIncludeTax).toBe(true)
    expect(result.taxMinor).toBe(1500n)
    expect(result.breakdown).toEqual([{ label: 'GST', ratePercent: 15, amountMinor: 1500n }])
  })

  it('gstRatePercent null falls back to the statutory default (5% IN, 10% AU)', () => {
    const inResult = computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 20000n, gstRatePercent: null })
    expect(inResult.taxMinor).toBe(1000n)
    const auResult = computeTax({ country: 'AU', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 11000n, gstRatePercent: null })
    expect(auResult.taxMinor).toBe(1000n)
  })

  it('zero subtotal produces zero tax in every branch', () => {
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'IGST', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: true, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'AU', gstRegistered: true, taxProfile: '', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
    expect(computeTax({ country: 'AU', gstRegistered: false, taxProfile: '', compositionScheme: false, subtotalMinor: 0n }).taxMinor).toBe(0n)
  })

  describe('gstSplitRounding (per-tenant CGST/SGST rule, #244)', () => {
    const inSplit = (subtotalMinor: bigint, gstSplitRounding?: GstSplitRounding) =>
      computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'India GST - CGST/SGST split', compositionScheme: false, subtotalMinor, gstSplitRounding })

    it.each([
      ['exact_total', 722n, 723n, 1445n],
      ['equal_half_up', 723n, 723n, 1446n],
      ['equal_half_even', 722n, 722n, 1444n],
    ] as const)('Rs 289 at 5%% under %s is %s + %s', (mode, cgst, sgst, total) => {
      const result = inSplit(28900n, mode)
      expect(result.breakdown.map((l) => [l.label, l.amountMinor])).toEqual([['CGST', cgst], ['SGST', sgst]])
      expect(result.taxMinor).toBe(total)
      expect(sumBreakdown(result.breakdown)).toBe(result.taxMinor)
      expect(result.gstSplitRounding).toBe(mode)
    })

    it('defaults to exact_total when the setting is not given', () => {
      const result = inSplit(28900n)
      expect(result.breakdown.map((l) => l.amountMinor)).toEqual([722n, 723n])
      expect(result.gstSplitRounding).toBe('exact_total')
    })

    it('equal_half_even rounds a half-paisa tie to the even paisa', () => {
      // 30 * 2.5% = 0.75 per half -> 1 (not a tie); 52020 * 2.5% = 1300.5 -> 1300 (even).
      expect(inSplit(30n, 'equal_half_even').breakdown.map((l) => l.amountMinor)).toEqual([1n, 1n])
      expect(inSplit(52020n, 'equal_half_even').breakdown.map((l) => l.amountMinor)).toEqual([1300n, 1300n])
      // 52060 * 2.5% = 1301.5 -> 1302 (even).
      expect(inSplit(52060n, 'equal_half_even').breakdown.map((l) => l.amountMinor)).toEqual([1302n, 1302n])
    })

    it('an even-paisa total splits the same under every rule', () => {
      for (const mode of ['exact_total', 'equal_half_up', 'equal_half_even'] as const) {
        const result = inSplit(28800n, mode) // 1440 -> 720 + 720
        expect(result.taxMinor).toBe(1440n)
        expect(result.breakdown.map((l) => l.amountMinor)).toEqual([720n, 720n])
      }
    })

    it('IGST, composition and AU ignore the setting and report null', () => {
      for (const mode of ['exact_total', 'equal_half_up', 'equal_half_even'] as const) {
        const igst = computeTax({ country: 'IN', gstRegistered: true, taxProfile: 'IGST', compositionScheme: false, subtotalMinor: 28900n, gstSplitRounding: mode })
        expect(igst.breakdown).toEqual([{ label: 'IGST', ratePercent: 5, amountMinor: 1445n }])
        expect(igst.gstSplitRounding).toBeNull()

        const composition = computeTax({ country: 'IN', gstRegistered: true, taxProfile: '', compositionScheme: true, subtotalMinor: 28900n, gstSplitRounding: mode })
        expect(composition.taxMinor).toBe(0n)
        expect(composition.gstSplitRounding).toBeNull()

        const au = computeTax({ country: 'AU', gstRegistered: true, taxProfile: 'Australia GST', compositionScheme: false, subtotalMinor: 28900n, gstSplitRounding: mode })
        expect(au.taxMinor).toBe(2627n) // 28900 - round(28900 * 10 / 11)
        expect(au.gstSplitRounding).toBeNull()
      }
    })
  })
})
