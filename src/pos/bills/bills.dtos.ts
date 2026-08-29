// pos/CAP-7 bill & settle. staffId/tenantId are never accepted from the
// request body - they come from the signed-in pos session, same posture as
// every other pos DTO (AD-5).
import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from 'class-validator'
import type { BillStatus, TenderMethod } from '../../generated/prisma/client'

export const TENDER_METHODS = ['cash', 'upi_manual'] as const

export class TenderDto {
  @IsIn(TENDER_METHODS)
  method!: TenderMethod

  // A tender is a real payment - zero or negative isn't one.
  @IsInt() @Min(1)
  amountMinor!: number
}

// discountMinor/discountReason are optional, but only together - a bare
// discount with no reason (or a reason with no amount) is rejected in the
// service, not here, since class-validator has no clean "both or neither"
// decorator for two independent optional fields.
export class FinalizeBillDto {
  @IsOptional() @IsInt() @Min(1)
  discountMinor?: number

  @IsOptional() @IsString() @MinLength(1)
  discountReason?: string

  // Only required when the discount clears CAP-7's above-threshold gate
  // (platform/manager-auth, AD-15) - checked in the service, not validated
  // as required here, since whether it's needed depends on discountMinor.
  @IsOptional() @IsString() @MinLength(1)
  managerPin?: string

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TenderDto)
  tenders!: TenderDto[]
}

export interface TenderView {
  id: string
  method: TenderMethod
  amountMinor: number
  createdAt: string
}

export interface BillView {
  id: string
  tenantId: string
  outletId: string
  orderId: string
  billNumber: number | null
  subtotalMinor: number
  taxMinor: number
  discountMinor: number | null
  discountReason: string | null
  // Convenience total the client would otherwise have to recompute itself:
  // subtotal + tax - discount. Never persisted as its own column - always
  // derived from the three that are.
  totalMinor: number
  status: BillStatus
  // qr-self-order/CAP-5 (issue #80): null for a guest-checkout Bill (no
  // staff creator - see Bill.createdByStaffId's schema comment).
  createdByStaffId: string | null
  createdAt: string
  finalizedByStaffId: string | null
  finalizedAt: string | null
  tenders: TenderView[]
}

// pos/CAP-9 refunds & adjustments. A refund line names an existing OrderLine
// on the bill's order and how many of its units to reverse - see
// bills.service.ts's refund() for why itemization targets OrderLine rather
// than a Bill line (Bill has none of its own).
export class RefundLineDto {
  @IsUUID()
  orderLineId!: string

  // How many units of this line to refund - at least 1, and never more than
  // that line's own quantity minus whatever earlier credit notes already
  // reversed (checked in the service, not here).
  @IsInt() @Min(1)
  quantity!: number
}

// managerPin/reason are both mandatory here, unlike FinalizeBillDto's
// conditional pair - refund is one of CAP-8's six gated actions
// unconditionally (AD-15), not only above some threshold.
export class RefundBillDto {
  @IsString() @MinLength(1)
  managerPin!: string

  @IsString() @MinLength(1)
  reason!: string

  // Omitted entirely: refund every order line's full remaining
  // (not-yet-refunded) quantity - a whole-bill refund, not a separate code
  // path from a partial one.
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => RefundLineDto)
  lines?: RefundLineDto[]
}

export interface CreditNoteLineView {
  id: string
  orderLineId: string
  quantity: number
  unitPriceMinor: number
  amountMinor: number
}

export interface CreditNoteView {
  id: string
  tenantId: string
  originalBillId: string
  reason: string
  approvedByStaffId: string
  createdByStaffId: string
  subtotalMinor: number
  taxMinor: number
  // Same never-persisted-derived-total convention as BillView.totalMinor.
  totalMinor: number
  createdAt: string
  lines: CreditNoteLineView[]
}
