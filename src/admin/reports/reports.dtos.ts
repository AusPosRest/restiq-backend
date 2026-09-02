// CAP-9 reports catalogue. tenantId is never accepted from the request -
// every read is scoped to the signed-in owner's session (AD-5), same
// posture as every other admin DTO.
import { IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator'

export type ReportCategory = 'sales' | 'financial' | 'menu' | 'operations' | 'inventory' | 'labour'

export interface ReportCatalogueEntry {
  key: string
  name: string
  category: ReportCategory
  hasData: boolean
  message: string
  exportFormats: string[]
}

export type ExportDestinationStatus = 'not_connected'

export interface ExportDestinationView {
  key: string
  name: string
  status: ExportDestinationStatus
}

// Issue #104: payments history. outletId, when given, must belong to the
// caller's own tenant (404 otherwise) - omitted, the report spans every
// outlet. from/to filter on Bill.finalizedAt and are both optional/
// independent (either, both, or neither may be given).
//
// The global ValidationPipe here runs with no `transform: true` (see
// platform.module.ts), so a numeric query string never becomes a real
// number before reaching the handler - the same reason ops/dlq's cursor
// list validates its own `limit` by hand instead of `@IsInt()`. `limit`
// follows that precedent (ReportsService.parsePagination): class-validator
// only proves the params it can (UUID/ISO-date/string shape) below.
export class PaymentsFilterDto {
  @IsOptional() @IsUUID()
  outletId?: string

  @IsOptional() @IsISO8601()
  from?: string

  @IsOptional() @IsISO8601()
  to?: string
}

export class ListPaymentsQueryDto extends PaymentsFilterDto {
  @IsOptional() @IsString()
  cursor?: string

  @IsOptional() @IsString()
  limit?: string
}

export interface PaymentTenderRow {
  method: string
  amountMinor: number
  createdAt: string
}

export interface PaymentCreditNoteRow {
  id: string
  amountMinor: number
  reason: string
  createdAt: string
}

// taxBreakdown is intentionally absent: Bill carries no such column in this
// build's schema (checked against prisma/schema.prisma at the time of
// writing) - another branch is adding it. Add the field back here, sourced
// from bill.taxBreakdown, once that column lands.
export interface PaymentRow {
  billId: string
  billNumber: number
  finalizedAt: string
  outletId: string
  outletName: string
  orderId: string
  source: 'pos' | 'qr'
  tableLabel: string | null
  tokenNumber: number | null
  cashierName: string | null
  subtotalMinor: number
  discountMinor: number | null
  discountReason: string | null
  taxMinor: number
  totalMinor: number
  tenders: PaymentTenderRow[]
  creditNotes: PaymentCreditNoteRow[]
}

export interface PaymentsTotals {
  count: number
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  tenderedMinor: number
  refundedMinor: number
}

export interface PaymentsListResult {
  items: PaymentRow[]
  nextCursor: string | null
  totals: PaymentsTotals
}
