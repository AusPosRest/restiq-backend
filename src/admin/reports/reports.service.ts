// CAP-9 reports catalogue. RESTIQ's POS Core Loop has since shipped
// Order/Bill/Tender/CreditNote (pos/CAP-7, qr-self-order/CAP-5) - issue #104
// adds the first report built on it, Payments History. GST/BAS, Menu
// Engineering (by volume), Operations, Inventory, and Labour-cost still
// depend on data no capability writes yet (a per-item cost/margin model, a
// tax-registration-aware GST split, shift/labour rostering), so those stay
// honestly hasData:false with an explanatory message and no export formats -
// same "never present a fabricated number as current" posture as CAP-8's
// dashboard (dashboard.service.ts).
//
// Three report types CAN be built from real data that already exists: a
// menu catalogue export (CAP-4's menu_categories/menu_items/item_prices), a
// staff roster export (CAP-7's staff_users/roles), and payments history
// (pos/CAP-7's bills/tenders/credit_notes). All three are real, tenant-scoped
// reads/CSV exports backed by live tables, not samples.
//
// The accounting export destination list (Tally/Xero/MYOB/Zoho/QuickBooks)
// is static and every destination is honestly "not_connected" - no OAuth/API
// integration to any of these exists anywhere in the codebase yet.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { AdminPrincipal, RegionRegistryService } from '../../platform'
import { setTenantContext } from '../menu/tenant-context'
import { resolveCurrentPrice } from '../menu/pricing'
import { pinStatus } from '../staff/staff.service'
import { toCsv } from './csv'
import {
  ExportDestinationView,
  ListPaymentsQueryDto,
  PaymentCreditNoteRow,
  PaymentRow,
  PaymentsFilterDto,
  PaymentsListResult,
  PaymentsTotals,
  ReportCatalogueEntry,
} from './reports.dtos'

const PENDING_ON_POS_MESSAGE = 'Available once POS Core Loop is live'

// One entry per named report type from the SPEC/PRD (CAP-9). The two with
// hasData:true are backed by real tenant tables today; the rest depend on
// transactional order/bill data that doesn't exist yet.
const REPORT_CATALOGUE: ReportCatalogueEntry[] = [
  { key: 'sales-summary', name: 'Sales Summary', category: 'sales', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'gst-bas', name: 'GST/BAS Report', category: 'financial', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'payments', name: 'Payments History', category: 'sales', hasData: true, message: 'Finalised bills, tenders, and credit notes from your live POS', exportFormats: ['csv'] },
  { key: 'menu-catalogue', name: 'Menu Catalogue', category: 'menu', hasData: true, message: 'Current categories, items, and prices from your live menu', exportFormats: ['csv'] },
  { key: 'menu-engineering', name: 'Menu Engineering', category: 'menu', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'operations-summary', name: 'Operations Summary', category: 'operations', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'inventory-summary', name: 'Inventory Summary', category: 'inventory', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
  { key: 'staff-roster', name: 'Staff Roster', category: 'labour', hasData: true, message: 'Current staff and their assigned roles', exportFormats: ['csv'] },
  { key: 'labour-cost', name: 'Labour Cost', category: 'labour', hasData: false, message: PENDING_ON_POS_MESSAGE, exportFormats: [] },
]

const EXPORT_DESTINATIONS: ExportDestinationView[] = [
  { key: 'tally', name: 'Tally', status: 'not_connected' },
  { key: 'xero', name: 'Xero', status: 'not_connected' },
  { key: 'myob', name: 'MYOB', status: 'not_connected' },
  { key: 'zoho', name: 'Zoho Books', status: 'not_connected' },
  { key: 'quickbooks', name: 'QuickBooks', status: 'not_connected' },
]

function formatMinor(minor: bigint): string {
  return (Number(minor) / 100).toFixed(2)
}

// Both exports currently only produce CSV (see each catalogue entry's
// exportFormats) - a bad/missing format is a 400, not a silent fallback.
function assertCsvFormat(format: string): void {
  if (format !== 'csv') {
    throw new BadRequestException({ code: 'validation_failed', message: 'format must be csv' })
  }
}

const PAYMENTS_LIMIT_DEFAULT = 50
const PAYMENTS_LIMIT_MAX = 200

// Keyset cursor on (finalizedAt, id) - same base64url-JSON convention as
// ops/dlq's cursor (that one is private to its own file, so this is a small
// local copy rather than a cross-realm import).
interface PaymentsCursor {
  finalizedAt: string
  id: string
}

function encodePaymentsCursor(cursor: PaymentsCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodePaymentsCursor(raw: string): PaymentsCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (typeof parsed === 'object' && parsed !== null) {
      const { finalizedAt, id } = parsed as Partial<PaymentsCursor>
      if (typeof finalizedAt === 'string' && typeof id === 'string') return { finalizedAt, id }
    }
  } catch {
    // fall through
  }
  throw new BadRequestException({ code: 'validation_failed', message: 'cursor is not valid' })
}

// limit stays a string on the DTO (see reports.dtos.ts's PaymentsFilterDto
// comment - no `transform: true` on the global ValidationPipe), so its
// integer-range check happens here by hand, same as ops/dlq.
function parsePaymentsLimit(raw: string | undefined): number {
  if (raw === undefined) return PAYMENTS_LIMIT_DEFAULT
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > PAYMENTS_LIMIT_MAX) {
    throw new BadRequestException({ code: 'validation_failed', message: `limit must be an integer between 1 and ${PAYMENTS_LIMIT_MAX}` })
  }
  return limit
}

function parsePaymentsDateRange(filter: PaymentsFilterDto): { from: Date | undefined; to: Date | undefined } {
  return { from: filter.from ? new Date(filter.from) : undefined, to: filter.to ? new Date(filter.to) : undefined }
}

// Shared by the paginated list and its whole-range totals, and by the CSV
// export - one WHERE, three readers. tenantId always comes from the
// caller's own session (AD-5); outletId, once asserted to belong to that
// tenant, narrows it further.
function paymentsWhere(tenantId: string, filter: PaymentsFilterDto): Prisma.BillWhereInput {
  const { from, to } = parsePaymentsDateRange(filter)
  return {
    tenantId,
    status: 'finalized',
    ...(filter.outletId && { outletId: filter.outletId }),
    ...((from || to) && { finalizedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
  }
}

const PAYMENTS_INCLUDE = {
  outlet: { select: { name: true } },
  order: { select: { source: true, tokenNumber: true, table: { select: { label: true } } } },
  finalizedByStaff: { select: { name: true } },
  tenders: { orderBy: { createdAt: 'asc' as const } },
  creditNotes: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.BillInclude
type BillWithPaymentsInclude = Prisma.BillGetPayload<{ include: typeof PAYMENTS_INCLUDE }>

function toCreditNoteRow(note: BillWithPaymentsInclude['creditNotes'][number]): PaymentCreditNoteRow {
  // CreditNote has no single amountMinor column - its refunded total is
  // subtotal + tax, the same never-persisted-derived-total convention
  // Bill.totalMinor and CreditNoteView already use (see the CreditNote
  // model's schema comment).
  return { id: note.id, amountMinor: Number(note.subtotalMinor + note.taxMinor), reason: note.reason, createdAt: note.createdAt.toISOString() }
}

function toPaymentRow(bill: BillWithPaymentsInclude): PaymentRow {
  const discountMinor = bill.discountMinor ?? 0n
  return {
    billId: bill.id,
    // Non-null: paymentsWhere() only ever selects status:'finalized' bills,
    // and commitFinalize() (pos/bills/bill-core.ts) sets billNumber in the
    // same write that flips status to 'finalized'.
    billNumber: bill.billNumber as number,
    finalizedAt: (bill.finalizedAt as Date).toISOString(),
    outletId: bill.outletId,
    outletName: bill.outlet.name,
    orderId: bill.orderId,
    source: bill.order.source,
    tableLabel: bill.order.table?.label ?? null,
    tokenNumber: bill.order.tokenNumber,
    cashierName: bill.finalizedByStaff?.name ?? null,
    subtotalMinor: Number(bill.subtotalMinor),
    discountMinor: bill.discountMinor === null ? null : Number(bill.discountMinor),
    discountReason: bill.discountReason,
    taxMinor: Number(bill.taxMinor),
    totalMinor: Number(bill.subtotalMinor + bill.taxMinor - discountMinor),
    tenders: bill.tenders.map((t) => ({ method: t.method, amountMinor: Number(t.amountMinor), createdAt: t.createdAt.toISOString() })),
    creditNotes: bill.creditNotes.map(toCreditNoteRow),
  }
}

@Injectable()
export class ReportsService {
  constructor(private readonly registry: RegionRegistryService) {}

  // Tenant-agnostic report definitions - no DB read, same list for every
  // caller (the guard already requires a valid owner session to reach it).
  catalogue(): ReportCatalogueEntry[] {
    return REPORT_CATALOGUE
  }

  exportDestinations(): ExportDestinationView[] {
    return EXPORT_DESTINATIONS
  }

  // Real CSV of the live menu: category, item, short name, variant (if any),
  // current price, currency, and 86 status. "Current price" uses the same
  // resolution rule as CAP-4's live read (menu/pricing.ts), taken for the
  // dine-in channel with no outlet override, since a report needs one
  // representative price per row rather than a per-channel/per-outlet
  // matrix. An item/variant with no priced row yet exports an empty price
  // rather than a fabricated one.
  async exportMenuCatalogueCsv(owner: AdminPrincipal, format: string): Promise<string> {
    assertCsvFormat(format)
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const items = await tx.menuItem.findMany({
        where: { tenantId: owner.tenantId },
        include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
        orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      })

      const rows: string[][] = []
      for (const item of items) {
        const lines: { id: string | null; name: string | null }[] = item.variants.length > 0 ? item.variants.map((v) => ({ id: v.id, name: v.name })) : [{ id: null, name: null }]
        for (const line of lines) {
          const price = await resolveCurrentPrice(tx, { tenantId: owner.tenantId, itemId: item.id, variantId: line.id, channel: 'dine_in', outletId: null })
          rows.push([item.category.name, item.name, item.shortName, line.name ?? '', price ? formatMinor(price.priceMinor) : '', price ? price.currency : '', item.available ? 'yes' : 'no'])
        }
      }

      return toCsv(['category', 'item', 'short_name', 'variant', 'price', 'currency', 'available'], rows)
    })
  }

  // Real CSV of current staff: name, email, assigned role, PIN status.
  async exportStaffRosterCsv(owner: AdminPrincipal, format: string): Promise<string> {
    assertCsvFormat(format)
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      const staff = await tx.staffUser.findMany({
        where: { tenantId: owner.tenantId },
        include: { role: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      })
      const rows = staff.map((s) => [s.name, s.email ?? '', s.role.name, pinStatus(s)])
      return toCsv(['name', 'email', 'role', 'pin_status'], rows)
    })
  }

  private async assertOutlet(tx: Prisma.TransactionClient, tenantId: string, outletId: string): Promise<void> {
    const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
    if (!outlet || outlet.tenantId !== tenantId) {
      throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
    }
  }

  private async totalsFor(tx: Prisma.TransactionClient, where: Prisma.BillWhereInput): Promise<PaymentsTotals> {
    const [billAgg, tenderAgg, creditNoteAgg] = await Promise.all([
      tx.bill.aggregate({ where, _count: true, _sum: { subtotalMinor: true, discountMinor: true, taxMinor: true } }),
      tx.tender.aggregate({ where: { bill: where }, _sum: { amountMinor: true } }),
      tx.creditNote.aggregate({ where: { originalBill: where }, _sum: { subtotalMinor: true, taxMinor: true } }),
    ])
    const subtotalMinor = billAgg._sum.subtotalMinor ?? 0n
    const discountMinor = billAgg._sum.discountMinor ?? 0n
    const taxMinor = billAgg._sum.taxMinor ?? 0n
    const refundedMinor = (creditNoteAgg._sum.subtotalMinor ?? 0n) + (creditNoteAgg._sum.taxMinor ?? 0n)
    return {
      count: billAgg._count,
      subtotalMinor: Number(subtotalMinor),
      discountMinor: Number(discountMinor),
      taxMinor: Number(taxMinor),
      totalMinor: Number(subtotalMinor + taxMinor - discountMinor),
      tenderedMinor: Number(tenderAgg._sum.amountMinor ?? 0n),
      refundedMinor: Number(refundedMinor),
    }
  }

  /**
   * Issue #104: finalised bills only, newest finalizedAt first, keyset-
   * paginated on (finalizedAt, id). `totals` always covers the whole
   * filtered range (every matching bill), never just the returned page -
   * computed by totalsFor() against the same paymentsWhere(), with no
   * cursor/limit applied.
   */
  async listPayments(owner: AdminPrincipal, query: ListPaymentsQueryDto): Promise<PaymentsListResult> {
    const limit = parsePaymentsLimit(query.limit)
    const cursor = query.cursor === undefined || query.cursor === '' ? undefined : decodePaymentsCursor(query.cursor)

    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      if (query.outletId) await this.assertOutlet(tx, owner.tenantId, query.outletId)

      const where = paymentsWhere(owner.tenantId, query)
      const pageWhere: Prisma.BillWhereInput = cursor
        ? { ...where, OR: [{ finalizedAt: { lt: new Date(cursor.finalizedAt) } }, { finalizedAt: new Date(cursor.finalizedAt), id: { lt: cursor.id } }] }
        : where

      const [rows, totals] = await Promise.all([
        tx.bill.findMany({ where: pageWhere, orderBy: [{ finalizedAt: 'desc' }, { id: 'desc' }], take: limit + 1, include: PAYMENTS_INCLUDE }),
        this.totalsFor(tx, where),
      ])

      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      const nextCursor = rows.length > limit && last?.finalizedAt ? encodePaymentsCursor({ finalizedAt: last.finalizedAt.toISOString(), id: last.id }) : null

      return { items: page.map(toPaymentRow), nextCursor, totals }
    })
  }

  // Same filters as listPayments, no pagination - one row per bill, tenders
  // and credit notes flattened into "method=amount;method=amount" cells so
  // a variable number of either never needs a variable number of columns.
  async exportPaymentsCsv(owner: AdminPrincipal, filter: PaymentsFilterDto): Promise<string> {
    const plane = this.registry.planeFor(this.registry.homeRegion())
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, owner.tenantId)
      if (filter.outletId) await this.assertOutlet(tx, owner.tenantId, filter.outletId)

      const where = paymentsWhere(owner.tenantId, filter)
      const bills = await tx.bill.findMany({ where, orderBy: [{ finalizedAt: 'desc' }, { id: 'desc' }], include: PAYMENTS_INCLUDE })

      const rows = bills.map((bill) => {
        const row = toPaymentRow(bill)
        const tenders = row.tenders.map((t) => `${t.method}=${formatMinor(BigInt(t.amountMinor))}`).join(';')
        const creditNotes = row.creditNotes.map((c) => `${c.reason}=${formatMinor(BigInt(c.amountMinor))}`).join(';')
        return [
          row.billNumber.toString(),
          row.finalizedAt,
          row.outletName,
          row.source,
          row.tableLabel ?? '',
          row.tokenNumber === null ? '' : row.tokenNumber.toString(),
          row.cashierName ?? '',
          formatMinor(BigInt(row.subtotalMinor)),
          formatMinor(BigInt(row.discountMinor ?? 0)),
          row.discountReason ?? '',
          formatMinor(BigInt(row.taxMinor)),
          formatMinor(BigInt(row.totalMinor)),
          tenders,
          creditNotes,
        ]
      })

      return toCsv(
        ['bill_number', 'finalized_at', 'outlet', 'source', 'table', 'token_number', 'cashier', 'subtotal', 'discount', 'discount_reason', 'tax', 'total', 'tenders', 'credit_notes'],
        rows,
      )
    })
  }
}
