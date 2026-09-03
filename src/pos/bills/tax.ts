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
  subtotalMinor: bigint
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

export function computeTax(params: ComputeTaxParams): TaxResult {
  const { country, taxProfile, compositionScheme, subtotalMinor } = params

  if (country === 'IN') {
    if (compositionScheme) {
      return { taxMinor: 0n, pricesIncludeTax: false, breakdown: [], notes: [COMPOSITION_NOTE] }
    }

    if (isIgstProfile(taxProfile)) {
      const amountMinor = roundHalfUp(subtotalMinor * 5n, 100n)
      return { taxMinor: amountMinor, pricesIncludeTax: false, breakdown: [{ label: 'IGST', ratePercent: 5, amountMinor }], notes: [] }
    }

    // CGST/SGST split: the total is rounded once (the authoritative figure),
    // CGST is rounded independently at its own 2.5% rate, and SGST absorbs
    // whatever the two roundings leave over - so the two lines always sum
    // exactly to taxMinor, never off by the rounding unit either way.
    const taxMinor = roundHalfUp(subtotalMinor * 5n, 100n)
    const cgstMinor = roundHalfUp(subtotalMinor * 25n, 1000n)
    const sgstMinor = taxMinor - cgstMinor
    return {
      taxMinor,
      pricesIncludeTax: false,
      breakdown: [
        { label: 'CGST', ratePercent: 2.5, amountMinor: cgstMinor },
        { label: 'SGST', ratePercent: 2.5, amountMinor: sgstMinor },
      ],
      notes: [],
    }
  }

  // AU: GST 10%, prices tax-inclusive - subtotalMinor is the customer-facing
  // total, and the tax is backed out of it rather than added on top.
  const taxMinor = subtotalMinor - roundHalfUp(subtotalMinor * 10n, 11n)
  return { taxMinor, pricesIncludeTax: true, breakdown: [{ label: 'GST', ratePercent: 10, amountMinor: taxMinor }], notes: [] }
}
