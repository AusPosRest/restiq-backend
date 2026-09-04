// pos/CAP-7 bill & settle (AD-14), extracted for qr-self-order/CAP-5 (issue
// #80, AD-18: "one order pipeline, many writers" - here, one Bill/Tender
// money path, many writers). This file holds the framework-free pieces of
// bill creation/finalisation - no PosPrincipal, no NestJS decorators, no
// staff-ownership rule - so both bills.service.ts (staff path, below) and
// src/guest/bills (guest checkout) can call the exact same money-path code
// without duplicating it.
//
// Why a plain file instead of DI: PosModule already imports GuestModule
// (pos/tables' staff-side session close reuses GuestSessionsService), so
// GuestModule importing PosModule back for a real NestJS provider would
// cycle the DI graph - the same reason guest/orders/orders.service.ts's
// top comment gives for not calling into pos/orders' staff-gated services.
// These functions carry no such dependency (they take plain ids, never a
// PosPrincipal), so guest/bills imports them directly through this file's
// scoped barrel (src/pos/bills/index.ts - see eslint.config.mjs's
// '!**/pos/bills' exception to the pos-module-boundary rule) with no cycle.
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { uuidv7 } from '../../platform'
import { BillView, InvoiceCreditNoteView, InvoiceLineView, InvoiceView, TaxBreakdownLineView, TenderView } from './bills.dtos'
import { computeTax, TaxBreakdownLine, TaxCountry } from './tax'

type Tx = Prisma.TransactionClient

export interface TenantTaxProfile {
  country: TaxCountry
  // '' when the tenant has no TenantTaxRegistration row yet (e.g. a tenant
  // provisioned before this story, or a test fixture that never seeded one) -
  // tax.ts's computeTax() treats that the same as any other non-IGST profile
  // (the CGST/SGST split), which is also the ordinary domestic-supply case.
  taxProfile: string
  compositionScheme: boolean
  gstRegistered: boolean
  legalEntityName: string | null
  registrationNumber: string | null
  fssaiLicense: string | null
  brandingTokens: Prisma.JsonValue
  contactPhone: string
  contactEmail: string
}

function readReceiptFooter(brandingTokens: Prisma.JsonValue): string | null {
  const map =
    typeof brandingTokens === 'object' && brandingTokens !== null && !Array.isArray(brandingTokens)
      ? (brandingTokens as Record<string, unknown>)
      : {}
  return typeof map.receiptFooter === 'string' ? map.receiptFooter : null
}

/**
 * Issue #103: the one place a Bill computation loads a tenant's country +
 * tax registration - called once per bill creation (and again, separately,
 * whenever the tax-invoice view is built, since that needs the seller
 * detail fields too). findFirst, not a unique lookup: the schema carries no
 * @@unique([tenantId]) on TenantTaxRegistration, but
 * TenantTaxRegistration.registrationNumber's own comment ("one legal entity,
 * one tenant per region") documents that only one row is ever expected.
 */
export async function loadTenantTaxProfile(tx: Tx, tenantId: string): Promise<TenantTaxProfile> {
  const [tenant, registration] = await Promise.all([
    tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { country: true, name: true, brandingTokens: true, contactPhone: true, contactEmail: true },
    }),
    tx.tenantTaxRegistration.findFirst({ where: { tenantId } }),
  ])
  return {
    country: tenant.country,
    taxProfile: registration?.taxProfile ?? '',
    compositionScheme: registration?.compositionScheme ?? false,
    gstRegistered: registration?.gstRegistered ?? true,
    legalEntityName: registration?.legalEntityName ?? tenant.name,
    registrationNumber: registration?.registrationNumber ?? null,
    fssaiLicense: registration?.fssaiLicense ?? null,
    brandingTokens: tenant.brandingTokens,
    contactPhone: tenant.contactPhone,
    contactEmail: tenant.contactEmail,
  }
}

// The tax_breakdown JSONB column's actual on-disk shape: the engine's
// breakdown lines AND its notes (e.g. the composition-scheme statutory
// wording) together, both snapshotted at bill-creation time - notes are
// exactly as tenant-configuration-dependent as the lines are (tax.ts derives
// both from the same country/taxProfile/compositionScheme triple), so an
// invoice built later must read the note that actually applied at billing
// time, not one freshly recomputed against whatever the tenant's tax
// registration says today.
interface StoredTaxBreakdown {
  lines: TaxBreakdownLineView[]
  notes: string[]
}

function toStoredTaxBreakdown(lines: TaxBreakdownLine[], notes: string[]): StoredTaxBreakdown {
  return { lines: lines.map((l) => ({ label: l.label, ratePercent: l.ratePercent, amountMinor: Number(l.amountMinor) })), notes }
}

function readStoredTaxBreakdown(taxBreakdown: Prisma.JsonValue | null): StoredTaxBreakdown {
  const stored = taxBreakdown as StoredTaxBreakdown | null
  return { lines: stored?.lines ?? [], notes: stored?.notes ?? [] }
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/**
 * Issue #103: the customer-payable total, aware of pricesIncludeTax. For an
 * exclusive-tax bill (IN), tax sits on top of subtotalMinor, so the total is
 * subtotal + tax - discount, same formula this module always used. For an
 * inclusive-tax bill (AU), subtotalMinor IS already the tax-inclusive figure
 * (computeSubtotal() sums the order lines' own menu prices unchanged - it
 * has no country awareness of its own) and taxMinor is only how much of that
 * subtotal is GST, not an amount owed on top of it - adding it again would
 * charge the GST twice. Shared by toBillView, commitFinalize's tender-sum
 * validation, and buildInvoiceView, so all three always agree on one number.
 */
function computeTotalMinor(subtotalMinor: bigint, taxMinor: bigint, discountMinor: bigint, pricesIncludeTax: boolean): bigint {
  return pricesIncludeTax ? subtotalMinor - discountMinor : subtotalMinor + taxMinor - discountMinor
}

export const BILL_INCLUDE = { tenders: { orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.BillInclude
export type BillWithTenders = Prisma.BillGetPayload<{ include: typeof BILL_INCLUDE }>

function toTenderView(t: BillWithTenders['tenders'][number]): TenderView {
  return { id: t.id, method: t.method, amountMinor: Number(t.amountMinor), createdAt: t.createdAt.toISOString() }
}

export function toBillView(bill: BillWithTenders): BillView {
  const discountMinor = bill.discountMinor ?? 0n
  return {
    id: bill.id,
    tenantId: bill.tenantId,
    outletId: bill.outletId,
    orderId: bill.orderId,
    billNumber: bill.billNumber,
    subtotalMinor: Number(bill.subtotalMinor),
    taxMinor: Number(bill.taxMinor),
    // [] rather than null for a pre-migration bill that predates this
    // column, so callers never need a null check on top of an array one.
    taxBreakdown: readStoredTaxBreakdown(bill.taxBreakdown).lines,
    pricesIncludeTax: bill.pricesIncludeTax,
    discountMinor: bill.discountMinor === null ? null : Number(bill.discountMinor),
    discountReason: bill.discountReason,
    totalMinor: Number(computeTotalMinor(bill.subtotalMinor, bill.taxMinor, discountMinor, bill.pricesIncludeTax)),
    status: bill.status,
    createdByStaffId: bill.createdByStaffId,
    createdAt: bill.createdAt.toISOString(),
    finalizedByStaffId: bill.finalizedByStaffId,
    finalizedAt: bill.finalizedAt?.toISOString() ?? null,
    tenders: bill.tenders.map(toTenderView),
  }
}

export async function loadBill(tx: Tx, tenantId: string, billId: string): Promise<BillWithTenders> {
  const bill = await tx.bill.findUnique({ where: { id: billId }, include: BILL_INCLUDE })
  if (!bill || bill.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such bill' })
  }
  return bill
}

/** Sums an order's snapshotted lines (unit price + selected modifiers, times quantity) into subtotalMinor. */
export async function computeSubtotal(tx: Tx, orderId: string): Promise<bigint> {
  const lines = await tx.orderLine.findMany({ where: { orderId }, include: { modifiers: true } })
  let subtotal = 0n
  for (const line of lines) {
    const modifiersTotal = line.modifiers.reduce((sum, m) => sum + m.priceMinor, 0n)
    subtotal += BigInt(line.quantity) * (line.unitPriceMinor + modifiersTotal)
  }
  return subtotal
}

export interface CreateBillParams {
  tenantId: string
  outletId: string
  orderId: string
  // null for a guest-checkout Bill (src/guest/bills) - see
  // Bill.createdByStaffId's schema comment.
  createdByStaffId: string | null
  // True when the caller's own Order row already carries status 'closed'.
  // Only enforced when no Bill exists yet for this order (below) - an order
  // closed by an EARLIER call finalising this exact bill (bill-core's
  // commitFinalize also flips Order to closed) must still return that
  // existing bill idempotently, not this error. What it does guard is
  // pos/CAP-2's direct staff status PATCH (orders.service.ts's
  // FORWARD_TRANSITIONS allows sent->closed on its own, no bill involved) -
  // an order closed that way, with no Bill ever created, must still be
  // rejected.
  orderClosed: boolean
}

export interface CreateOrGetBillResult {
  bill: BillWithTenders
  created: boolean
}

/**
 * Issue #98: this POST is idempotent per orderId, not merged and never a
 * second row - if a Bill already exists for the order (open or finalized),
 * it's returned as-is with created:false so the caller can answer 200
 * instead of 201; only a genuinely new order gets a fresh Bill (created:true).
 * The schema's unique orderId constraint is still the real backstop for a
 * concurrent create race (AD-11/AD-14: never two Bill rows) - caught below
 * and turned into the same idempotent "return the existing bill" outcome
 * instead of a raw P2002 escaping.
 *
 * Caller-gated: bills.service.ts's createBill() checks owner-only
 * (pos/CAP-2's rule) before calling this; guest/bills has no ownership
 * concept (a guest order has no staff owner - see Order.ownerId's schema
 * comment) so it calls this directly after its own session/order-active
 * check.
 */
export async function createOrGetBillRecord(tx: Tx, params: CreateBillParams): Promise<CreateOrGetBillResult> {
  const existing = await tx.bill.findUnique({ where: { orderId: params.orderId }, include: BILL_INCLUDE })
  if (existing) {
    return { bill: existing, created: false }
  }

  if (params.orderClosed) {
    throw new ConflictException({ code: 'conflict', message: 'This order is already closed' })
  }

  const subtotalMinor = await computeSubtotal(tx, params.orderId)
  const taxContext = await loadTenantTaxProfile(tx, params.tenantId)
  const tax = computeTax({
    country: taxContext.country,
    taxProfile: taxContext.taxProfile,
    compositionScheme: taxContext.compositionScheme,
    gstRegistered: taxContext.gstRegistered,
    subtotalMinor,
  })

  try {
    const bill = await tx.bill.create({
      data: {
        id: uuidv7(),
        tenantId: params.tenantId,
        outletId: params.outletId,
        orderId: params.orderId,
        subtotalMinor,
        taxMinor: tax.taxMinor,
        taxBreakdown: toStoredTaxBreakdown(tax.breakdown, tax.notes) as unknown as Prisma.InputJsonValue,
        pricesIncludeTax: tax.pricesIncludeTax,
        createdByStaffId: params.createdByStaffId,
      },
      include: BILL_INCLUDE,
    })
    return { bill, created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await tx.bill.findUnique({ where: { orderId: params.orderId }, include: BILL_INCLUDE })
    if (!raced) throw error
    return { bill: raced, created: false }
  }
}

/** Inserts one Tender row against an open Bill - a real payment (AD-14), never UPDATEd or DELETEd once written. Returns the created row (its id links a guest BillShare to the Tender that settled it). */
export async function createTenderRecord(
  tx: Tx,
  params: { tenantId: string; billId: string; method: BillWithTenders['tenders'][number]['method']; amountMinor: bigint },
): Promise<BillWithTenders['tenders'][number]> {
  return tx.tender.create({
    data: { id: uuidv7(), tenantId: params.tenantId, billId: params.billId, method: params.method, amountMinor: params.amountMinor },
  })
}

export interface CommitFinalizeParams {
  tenantId: string
  bill: BillWithTenders
  discountMinor: bigint | null
  discountReason: string | null
  // null for a guest-checkout completion (src/guest/bills) - a guest bill
  // finalizes itself once every share is paid, no staff involved.
  finalizedByStaffId: string | null
}

/**
 * The mechanical half of finalising a Bill, shared by the staff path
 * (bills.service.ts's finalize(), after its own discount/manager-auth
 * gating) and the guest path (guest/bills, once every BillShare is paid):
 * verifies the already-inserted Tenders sum to the bill total, reserves the
 * next gapless bill number, flips the Bill to finalized (CAS on status, so a
 * concurrent double-finalise affects zero rows instead of double-applying),
 * and closes the Order - all in the caller's own transaction.
 */
export async function commitFinalize(tx: Tx, params: CommitFinalizeParams): Promise<BillWithTenders> {
  const { bill } = params
  if (bill.status === 'finalized') {
    throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
  }

  const totalMinor = computeTotalMinor(bill.subtotalMinor, bill.taxMinor, params.discountMinor ?? 0n, bill.pricesIncludeTax)
  const tenderAgg = await tx.tender.aggregate({ where: { billId: bill.id }, _sum: { amountMinor: true } })
  const tenderTotal = tenderAgg._sum.amountMinor ?? 0n
  if (tenderTotal !== totalMinor) {
    throw new BadRequestException({
      code: 'tender_mismatch',
      message: `Tenders sum to ${tenderTotal} but the bill total is ${totalMinor}`,
    })
  }

  // Reserve-then-commit (AD-14): the counter is touched only now, after
  // every validation above has already passed, and only inside this same
  // transaction - a validation failure earlier never reserves a number, and
  // if anything below still fails, the whole transaction (counter increment
  // included) rolls back with it. Either way, no gap.
  const counter = await tx.billNumberCounter.upsert({
    where: { outletId: bill.outletId },
    create: { id: uuidv7(), tenantId: params.tenantId, outletId: bill.outletId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  })

  // Compare-and-swap on status, not a plain update-by-id: if a concurrent
  // request already finalised this bill between the read above and here,
  // this affects zero rows instead of silently double-finalising it.
  const updated = await tx.bill.updateMany({
    where: { id: bill.id, status: 'open' },
    data: {
      billNumber: counter.lastNumber,
      discountMinor: params.discountMinor,
      discountReason: params.discountReason,
      status: 'finalized',
      finalizedByStaffId: params.finalizedByStaffId,
      finalizedAt: new Date(),
    },
  })
  if (updated.count === 0) {
    throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
  }

  // pos/CAP-2's comment on Order.status calls this out explicitly: "closed"
  // was a placeholder ahead of this exact story - finalising a Bill is what
  // actually closes the order, written directly (not through
  // orders.service.ts's FORWARD_TRANSITIONS-checked updateStatus) since that
  // guard is for staff-driven transitions, not this one.
  await tx.order.update({ where: { id: bill.orderId }, data: { status: 'closed' } })

  return loadBill(tx, params.tenantId, bill.id)
}

// Same IN->INR/AU->AUD rule ops/tenants/tenants.service.ts uses at
// provisioning to price the tenant's seed menu - Tenant carries no currency
// column of its own, so this is the one place that rule is re-derived rather
// than read back.
function currencyForCountry(country: TaxCountry): string {
  return country === 'IN' ? 'INR' : 'AUD'
}

/**
 * Issue #103: GET .../bills/:id/invoice's read model - built fresh on every
 * call (never persisted) from the Bill's own immutable snapshot
 * (subtotalMinor/taxMinor/taxBreakdown, discountMinor/discountReason,
 * billNumber/finalizedAt) plus the order's lines and the tenant's CURRENT
 * seller detail (legalEntityName/registrationNumber/fssaiLicense, outlet
 * name/address) - the seller's own registered details are a live legal fact,
 * unlike the tax breakdown, which is frozen at bill-creation time (see
 * StoredTaxBreakdown's comment). 409 not_finalized on a still-open bill: its
 * tax breakdown is provisional and it carries no billNumber/finalizedAt yet,
 * both of which this view requires.
 */
export async function buildInvoiceView(tx: Tx, tenantId: string, billId: string): Promise<InvoiceView> {
  const bill = await loadBill(tx, tenantId, billId)
  if (bill.status !== 'finalized' || !bill.billNumber || !bill.finalizedAt) {
    throw new ConflictException({ code: 'not_finalized', message: 'This bill has not been finalized yet' })
  }

  const [orderLines, outlet, taxContext, creditNotes] = await Promise.all([
    tx.orderLine.findMany({ where: { orderId: bill.orderId }, include: { item: true, modifiers: true }, orderBy: { createdAt: 'asc' } }),
    tx.outlet.findUniqueOrThrow({ where: { id: bill.outletId }, select: { name: true, address: true } }),
    loadTenantTaxProfile(tx, tenantId),
    tx.creditNote.findMany({ where: { originalBillId: bill.id }, orderBy: { createdAt: 'asc' } }),
  ])

  const lines: InvoiceLineView[] = orderLines.map((line) => {
    const modifiersTotal = line.modifiers.reduce((sum, m) => sum + m.priceMinor, 0n)
    const unitPriceMinor = line.unitPriceMinor + modifiersTotal
    return { name: line.item.name, quantity: line.quantity, unitPriceMinor: Number(unitPriceMinor), lineTotalMinor: Number(unitPriceMinor * BigInt(line.quantity)) }
  })

  const creditNoteViews: InvoiceCreditNoteView[] = creditNotes.map((note) => ({
    id: note.id,
    // pricesIncludeTax comes from the original Bill (no such column on
    // CreditNote) - same reasoning as computeTotalMinor above and
    // bills.service.ts's toCreditNoteView: an AU/inclusive bill's refunded
    // subtotal already contains its own tax.
    amountMinor: Number(bill.pricesIncludeTax ? note.subtotalMinor : note.subtotalMinor + note.taxMinor),
    reason: note.reason,
    createdAt: note.createdAt.toISOString(),
  }))

  const { lines: taxBreakdown, notes } = readStoredTaxBreakdown(bill.taxBreakdown)
  const discountMinor = bill.discountMinor ?? 0n

  return {
    invoiceNumber: String(bill.billNumber),
    title: taxContext.country === 'AU' ? (taxContext.gstRegistered ? 'Tax Invoice' : 'Receipt') : 'Invoice',
    issuedAt: bill.finalizedAt.toISOString(),
    currency: currencyForCountry(taxContext.country),
    seller: {
      legalEntityName: taxContext.legalEntityName ?? '',
      phone: taxContext.contactPhone,
      email: taxContext.contactEmail,
      registrationLabel: taxContext.country === 'AU' ? 'ABN' : 'GSTIN',
      registrationNumber: taxContext.registrationNumber ?? '',
      fssaiLicense: taxContext.fssaiLicense,
      outletName: outlet.name,
      outletAddress: outlet.address,
    },
    footerMessage: readReceiptFooter(taxContext.brandingTokens),
    lines,
    subtotalMinor: Number(bill.subtotalMinor),
    discountMinor: bill.discountMinor === null ? null : Number(bill.discountMinor),
    discountReason: bill.discountReason,
    taxBreakdown,
    taxMinor: Number(bill.taxMinor),
    totalMinor: Number(computeTotalMinor(bill.subtotalMinor, bill.taxMinor, discountMinor, bill.pricesIncludeTax)),
    pricesIncludeTax: bill.pricesIncludeTax,
    tenders: bill.tenders.map(toTenderView),
    creditNotes: creditNoteViews,
    notes,
  }
}
