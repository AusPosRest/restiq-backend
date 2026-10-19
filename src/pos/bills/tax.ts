// Country-aware tax engine (issue #103), replacing bill-core.ts's old flat
// TAX_RATE_PLACEHOLDER_PERCENT. Framework-free and DB-free by design (no tx,
// no Prisma types) - bill-core.ts's loadTenantTaxProfile() is the only piece
// that touches the database, so this module stays trivially unit-testable
// and reusable from both pos/bills and guest/bills.
//
// taxProfile is genuinely free text (TenantTaxRegistration.taxProfile, typed
// as a plain string by the onboarding wizard - see ops/tenants/submit.dto.ts)
// rather than a fixed enum, so IGST is detected by a case-insensitive
// substring match; anything else for an IN tenant (including an empty
// profile, e.g. a tenant with no TenantTaxRegistration row at all) defaults
// to the CGST/SGST split, which is also the ordinary domestic-supply case.
export type TaxCountry = 'IN' | 'AU'

// India CGST/SGST odd-paisa rule, per tenant (restiq-backend#244) - mirrors
// the Prisma enum GstSplitRounding.
export type GstSplitRounding = 'exact_total' | 'equal_half_up' | 'equal_half_even'

export interface ComputeTaxParams {
  country: TaxCountry
  taxProfile: string
  compositionScheme: boolean
  gstRegistered: boolean
  subtotalMinor: bigint
  // Tenant-configured rate (issue #121), overriding the 5% IN / 10% AU
  // statutory defaults below. Null/undefined means "use the default".
  gstRatePercent?: number | null
  // Only read for an IN CGST/SGST split. Undefined means 'exact_total'.
  gstSplitRounding?: GstSplitRounding
}

export interface TaxBreakdownLine {
  label: string
  ratePercent: number
  amountMinor: bigint
}

export interface TaxResult {
  taxMinor: bigint
  pricesIncludeTax: boolean
  breakdown: TaxBreakdownLine[]
  notes: string[]
  // The rule applied - null unless this was an IN CGST/SGST split.
  gstSplitRounding: GstSplitRounding | null
}

const COMPOSITION_NOTE = 'Composition taxable person, not eligible to collect tax on supplies'

/** round(numerator/denominator), half away from zero - deterministic, no floats. denominator > 0; a negative numerator (e.g. a legacy negative-priced modifier, SE-7) is rounded symmetrically rather than truncated toward zero. */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) return -roundHalfUp(-numerator, denominator)
  return (2n * numerator + denominator) / (2n * denominator)
}

/** round(numerator/denominator), ties to even (and symmetric for a negative numerator, like roundHalfUp). denominator > 0. */
function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) return -roundHalfEven(-numerator, denominator)
  const quotient = numerator / denominator
  const twiceRemainder = 2n * (numerator % denominator)
  if (twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n)) return quotient + 1n
  return quotient
}

function isIgstProfile(taxProfile: string): boolean {
  return taxProfile.toLowerCase().includes('igst')
}

// Rate as an integer number of basis points (rate * 100) so a configured
// rate with up to 2 decimal places (the column is NUMERIC(5,2)) never hits
// floating-point division - roundHalfUp does the only division, once, at
// the end, on exact bigints.
function rateBasisPoints(gstRatePercent: number | null | undefined, defaultPercent: number): bigint {
  return BigInt(Math.round((gstRatePercent ?? defaultPercent) * 100))
}

export function computeTax(params: ComputeTaxParams): TaxResult {
  const { country, gstRegistered, taxProfile, compositionScheme, subtotalMinor, gstRatePercent } = params
  const gstSplitRounding = params.gstSplitRounding ?? 'exact_total'

  if (country === 'IN') {
    if (compositionScheme) {
      return { taxMinor: 0n, pricesIncludeTax: false, breakdown: [], notes: [COMPOSITION_NOTE], gstSplitRounding: null }
    }

    const rateBasis = rateBasisPoints(gstRatePercent, 5)

    if (isIgstProfile(taxProfile)) {
      const amountMinor = roundHalfUp(subtotalMinor * rateBasis, 10_000n)
      return { taxMinor: amountMinor, pricesIncludeTax: false, breakdown: [{ label: 'IGST', ratePercent: Number(rateBasis) / 100, amountMinor }], notes: [], gstSplitRounding: null }
    }

    // CGST/SGST split (restiq-backend#244, AP-cu-15), rule set per tenant:
    // - exact_total (default): total GST is rounded once, exactly like IGST,
    //   then CGST takes the lower half and SGST the remainder, so the lines
    //   always add up to the rounded total (289.00 at 5% = 7.22 + 7.23).
    // - equal_half_up: each half rounded half-up on its own (the pre-#244
    //   rule; 7.23 + 7.23).
    // - equal_half_even: each half rounded half-to-even (7.22 + 7.22).
    let cgstMinor: bigint
    let sgstMinor: bigint
    if (gstSplitRounding === 'exact_total') {
      const totalMinor = roundHalfUp(subtotalMinor * rateBasis, 10_000n)
      cgstMinor = totalMinor / 2n
      sgstMinor = totalMinor - cgstMinor
    } else {
      const round = gstSplitRounding === 'equal_half_even' ? roundHalfEven : roundHalfUp
      cgstMinor = round(subtotalMinor * rateBasis, 20_000n)
      sgstMinor = cgstMinor
    }
    return {
      taxMinor: cgstMinor + sgstMinor,
      pricesIncludeTax: false,
      breakdown: [
        { label: 'CGST', ratePercent: Number(rateBasis) / 200, amountMinor: cgstMinor },
        { label: 'SGST', ratePercent: Number(rateBasis) / 200, amountMinor: sgstMinor },
      ],
      notes: [],
      gstSplitRounding,
    }
  }

  if (!gstRegistered) {
    return { taxMinor: 0n, pricesIncludeTax: false, breakdown: [], notes: ['Not registered for GST - this is a receipt, not a tax invoice'], gstSplitRounding: null }
  }

  // AU: GST, prices tax-inclusive - subtotalMinor is the customer-facing
  // total, and the tax is backed out of it rather than added on top.
  const rateBasis = rateBasisPoints(gstRatePercent, 10)
  const taxMinor = subtotalMinor - roundHalfUp(subtotalMinor * 10_000n, 10_000n + rateBasis)
  return { taxMinor, pricesIncludeTax: true, breakdown: [{ label: 'GST', ratePercent: Number(rateBasis) / 100, amountMinor: taxMinor }], notes: [], gstSplitRounding: null }
}
