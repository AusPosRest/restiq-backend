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

export interface ComputeTaxParams {
  country: TaxCountry
  taxProfile: string
  compositionScheme: boolean
  gstRegistered: boolean
  subtotalMinor: bigint
  // Tenant-configured rate (issue #121), overriding the 5% IN / 10% AU
  // statutory defaults below. Null/undefined means "use the default".
  gstRatePercent?: number | null
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
}

const COMPOSITION_NOTE = 'Composition taxable person, not eligible to collect tax on supplies'

/** round(numerator/denominator), half rounding up - deterministic, no floats. Both inputs are >= 0 (a subtotal minor-unit amount can never be negative). */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator)
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

  if (country === 'IN') {
    if (compositionScheme) {
      return { taxMinor: 0n, pricesIncludeTax: false, breakdown: [], notes: [COMPOSITION_NOTE] }
    }

    const rateBasis = rateBasisPoints(gstRatePercent, 5)

    if (isIgstProfile(taxProfile)) {
      const amountMinor = roundHalfUp(subtotalMinor * rateBasis, 10_000n)
      return { taxMinor: amountMinor, pricesIncludeTax: false, breakdown: [{ label: 'IGST', ratePercent: Number(rateBasis) / 100, amountMinor }], notes: [] }
    }

    // CGST/SGST split: the total is rounded once (the authoritative figure),
    // CGST is rounded independently at its own half-rate, and SGST absorbs
    // whatever the two roundings leave over - so the two lines always sum
    // exactly to taxMinor, never off by the rounding unit either way.
    const taxMinor = roundHalfUp(subtotalMinor * rateBasis, 10_000n)
    const cgstMinor = roundHalfUp(subtotalMinor * rateBasis, 20_000n)
    const sgstMinor = taxMinor - cgstMinor
    return {
      taxMinor,
      pricesIncludeTax: false,
      breakdown: [
        { label: 'CGST', ratePercent: Number(rateBasis) / 200, amountMinor: cgstMinor },
        { label: 'SGST', ratePercent: Number(rateBasis) / 200, amountMinor: sgstMinor },
      ],
      notes: [],
    }
  }

  if (!gstRegistered) {
    return { taxMinor: 0n, pricesIncludeTax: false, breakdown: [], notes: ['Not registered for GST - this is a receipt, not a tax invoice'] }
  }

  // AU: GST, prices tax-inclusive - subtotalMinor is the customer-facing
  // total, and the tax is backed out of it rather than added on top.
  const rateBasis = rateBasisPoints(gstRatePercent, 10)
  const taxMinor = subtotalMinor - roundHalfUp(subtotalMinor * 10_000n, 10_000n + rateBasis)
  return { taxMinor, pricesIncludeTax: true, breakdown: [{ label: 'GST', ratePercent: Number(rateBasis) / 100, amountMinor: taxMinor }], notes: [] }
}
