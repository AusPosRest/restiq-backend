// pos/CAP-7 bill & settle (AD-14). Finalises an Order (built by pos/CAP-2's
// orders.service.ts and pos/CAP-3's order-lines.service.ts, both reused
// as-is - loadOrder/assertOwner are imported, not reimplemented) into an
// immutable Bill. See prisma/schema.prisma's Bill/Tender/BillNumberCounter
// comment block for the insert-only-past-finalisation and reserve-then-
// commit numbering invariants this service must uphold.
//
// The actual bill-creation/finalisation mechanics live in ./bill-core.ts
// (framework-free, no PosPrincipal) - qr-self-order/CAP-5 (issue #80)
// reuses that exact code from guest/bills for guest checkout, through
// bill-core's own scoped barrel (./index.ts). This file stays the
// staff-facing shell: owner-only creation, discount/manager-auth gating on
// finalise, refunds.
//
// Split types (SPEC CAP-7: seat/item/N-way/amount/percent): this story
// implements the backend as "finalise against an arbitrary list of tenders".
// N-way and amount/percent splits are structurally just multiple Tender rows
// whose amounts sum to the bill total - however a client computed each
// tender's amount, this endpoint doesn't need to know. Per-seat/per-item
// splits are a web-side UI concern (SPEC's own words) of grouping lines
// before computing those tender amounts; OrderLine has no seat column yet
// (pos/CAP-4 group ordering, a different story) for the backend to enforce
// against, so this module doesn't validate a split's shape - only that
// whatever tenders arrive sum to the total.
//
// Tax (issue #103): a real, country-aware engine - see ./tax.ts's
// computeTax() and bill-core.ts's loadTenantTaxProfile(). Replaces the old
// flat TAX_RATE_PLACEHOLDER_PERCENT this comment used to point to.
//
// Discount-above-threshold: routes through platform/manager-auth
// (ManagerAuthService), per stories.yaml's explicit instruction, rather than
// accepting a bare reason string. SPEC.md's Assumptions section has no
// concrete default threshold value (still an open question there); this
// story picks 20% of the bill's subtotal, the example the spec's own memlog
// floated ("any discount over 20%") - see DISCOUNT_THRESHOLD_FRACTION.
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { ManagerApproval, ManagerAuthService, PosPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { assertOwner, loadOrder } from '../orders/orders.service'
import { buildInvoiceView, commitFinalize, createOrGetBillRecord, createTenderRecord, loadBill, toBillView } from './bill-core'
import { BillView, CreditNoteLineView, CreditNoteView, FinalizeBillDto, InvoiceView, RefundBillDto } from './bills.dtos'
import type { Prisma } from '../../generated/prisma/client'

// SPEC.md's Assumptions section defers the actual discount-above-threshold
// value to "a sane default...pending a real settings field" - this story's
// memlog names "any discount over 20%" as that default. TODO(tenant
// settings story): make this a real per-tenant configurable value.
const DISCOUNT_THRESHOLD_PERCENT = 20n

const CREDIT_NOTE_INCLUDE = { lines: { orderBy: { id: 'asc' as const } } } satisfies Prisma.CreditNoteInclude
type CreditNoteWithLines = Prisma.CreditNoteGetPayload<{ include: typeof CREDIT_NOTE_INCLUDE }>

function toCreditNoteLineView(l: CreditNoteWithLines['lines'][number]): CreditNoteLineView {
  return { id: l.id, orderLineId: l.orderLineId, quantity: l.quantity, unitPriceMinor: Number(l.unitPriceMinor), amountMinor: Number(l.amountMinor) }
}

// pricesIncludeTax comes from the original Bill, not CreditNote itself (no
// such column there) - same issue #103 reasoning as bill-core.ts's
// computeTotalMinor: for an AU/inclusive bill, the refunded subtotal already
// contains its own tax, so the payable total is the subtotal alone, not
// subtotal + tax again.
function toCreditNoteView(note: CreditNoteWithLines, pricesIncludeTax: boolean): CreditNoteView {
  return {
    id: note.id,
    tenantId: note.tenantId,
    originalBillId: note.originalBillId,
    reason: note.reason,
    approvedByStaffId: note.approvedByStaffId,
    createdByStaffId: note.createdByStaffId,
    subtotalMinor: Number(note.subtotalMinor),
    taxMinor: Number(note.taxMinor),
    totalMinor: pricesIncludeTax ? Number(note.subtotalMinor) : Number(note.subtotalMinor + note.taxMinor),
    createdAt: note.createdAt.toISOString(),
    lines: note.lines.map(toCreditNoteLineView),
  }
}

@Injectable()
export class BillsService {
  constructor(
    private readonly registry: RegionRegistryService,
    private readonly managerAuth: ManagerAuthService,
  ) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  /**
   * Creates an open Bill snapshotting the order's current lines into
   * subtotal/tax. Owner-only (CAP-2's rule, reused). The order must not
   * already be closed with no Bill yet: "sent" is the usual dine-in path
   * (fired to the kitchen already), but "open" is accepted too so a future
   * QSR/counter flow (pos/CAP-6, which the architecture map composes
   * directly over this module) can bill an order that never needed a
   * kitchen-fire step.
   *
   * Issue #98: idempotent per orderId - a fresh tab that lost its cached
   * bill id (the web settle screen's only prior way to find it) can just
   * POST again and get the same Bill back with 200, instead of a bare 409
   * with no id to recover from. `created` tells the controller which status
   * code to answer with; the BillView body is identical either way.
   */
  async createBill(staff: PosPrincipal, orderId: string): Promise<{ view: BillView; created: boolean }> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const order = await loadOrder(tx, staff.tenantId, orderId)
      await assertOwner(tx, order, staff)

      const { bill, created } = await createOrGetBillRecord(tx, {
        tenantId: staff.tenantId,
        outletId: order.outletId,
        orderId,
        createdByStaffId: staff.id,
        orderClosed: order.status === 'closed',
      })
      return { view: toBillView(bill), created }
    })
  }

  async getBill(staff: PosPrincipal, billId: string): Promise<BillView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const bill = await loadBill(tx, staff.tenantId, billId)
      return toBillView(bill)
    })
  }

  /** GET .../bills/:id/invoice - see bill-core.ts's buildInvoiceView for the 404/409 rules. */
  async getInvoice(staff: PosPrincipal, billId: string): Promise<InvoiceView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      return buildInvoiceView(tx, staff.tenantId, billId)
    })
  }

  /**
   * Validates discount/tender inputs, routes a discount above
   * DISCOUNT_THRESHOLD_PERCENT through platform/manager-auth (AD-15),
   * writes the tenders, then hands off to bill-core's commitFinalize for the
   * reserve-then-commit numbering and the CAS status flip - all in one
   * transaction. Not owner-only, unlike createBill: a cashier settling at a
   * register is frequently not the waiter who owns the order, and
   * SPEC-CAP-7 names no ownership restriction for this step.
   */
  async finalize(staff: PosPrincipal, billId: string, dto: FinalizeBillDto): Promise<BillView> {
    if ((dto.discountMinor === undefined) !== (dto.discountReason === undefined)) {
      throw new BadRequestException({ code: 'validation_failed', message: 'discountMinor and discountReason must be given together' })
    }

    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const bill = await loadBill(tx, staff.tenantId, billId)
      if (bill.status === 'finalized') {
        throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
      }

      const discountMinor = dto.discountMinor !== undefined ? BigInt(dto.discountMinor) : null
      const discountReason = dto.discountReason ?? null

      let approval: ManagerApproval | null = null
      if (discountMinor !== null) {
        const thresholdMinor = (bill.subtotalMinor * DISCOUNT_THRESHOLD_PERCENT) / 100n
        if (discountMinor > thresholdMinor) {
          if (!dto.managerPin) {
            throw new BadRequestException({ code: 'manager_pin_required', message: 'A manager PIN is required for a discount above the threshold' })
          }
          approval = await this.managerAuth.authorize('discount_above_threshold', staff.tenantId, bill.outletId, dto.managerPin, discountReason as string)
        }
      }

      for (const tender of dto.tenders) {
        await createTenderRecord(tx, { tenantId: staff.tenantId, billId, method: tender.method, amountMinor: BigInt(tender.amountMinor) })
      }

      const final = await commitFinalize(tx, {
        tenantId: staff.tenantId,
        bill,
        discountMinor,
        discountReason,
        finalizedByStaffId: staff.id,
      })

      if (approval) {
        await this.managerAuth.recordApproval(tx, approval, { actorId: staff.id, actorEmail: staff.name, occurredAt: new Date() })
      }

      return toBillView(final)
    })
  }

  /**
   * pos/CAP-9 refunds & adjustments (AD-14, AD-15). Refunds one or more
   * items - or, with no `lines` given, every item's full remaining quantity -
   * against an already-finalized Bill, gated by platform/manager-auth's
   * 'refund' action exactly like finalize()'s discount-above-threshold gate
   * above. Writes a brand-new CreditNote (+ CreditNoteLine rows) and the
   * manager-auth audit row in one transaction; the original Bill is never
   * read for a write here - no UPDATE statement touches "bills" or "tenders"
   * anywhere in this method, satisfying AD-14's "never mutates the original
   * Bill" success criterion structurally, not just by convention.
   */
  async refund(staff: PosPrincipal, billId: string, dto: RefundBillDto): Promise<CreditNoteView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const bill = await loadBill(tx, staff.tenantId, billId)
      if (bill.status !== 'finalized') {
        throw new ConflictException({ code: 'bill_not_finalized', message: 'Only a finalized bill can be refunded' })
      }

      const orderLines = await tx.orderLine.findMany({ where: { orderId: bill.orderId }, include: { modifiers: true } })
      const orderLineById = new Map(orderLines.map((l) => [l.id, l]))

      // Sum every earlier credit note's lines for this bill so a line can
      // never be refunded past its original quantity across multiple
      // refunds - CreditNoteLine has no other guard against double-refunding
      // the same units.
      const priorLines = await tx.creditNoteLine.findMany({ where: { creditNote: { originalBillId: billId } } })
      const refundedSoFar = new Map<string, number>()
      for (const l of priorLines) refundedSoFar.set(l.orderLineId, (refundedSoFar.get(l.orderLineId) ?? 0) + l.quantity)

      const targets =
        dto.lines ??
        orderLines
          .map((l) => ({ orderLineId: l.id, quantity: l.quantity - (refundedSoFar.get(l.id) ?? 0) }))
          .filter((t) => t.quantity > 0)

      if (targets.length === 0) {
        throw new BadRequestException({ code: 'nothing_to_refund', message: 'There is nothing left to refund on this bill' })
      }

      let subtotalMinor = 0n
      const lineData: { orderLineId: string; quantity: number; unitPriceMinor: bigint; amountMinor: bigint }[] = []
      for (const target of targets) {
        const line = orderLineById.get(target.orderLineId)
        if (!line) {
          throw new BadRequestException({ code: 'validation_failed', message: `Order line ${target.orderLineId} is not part of this bill` })
        }
        const remaining = line.quantity - (refundedSoFar.get(target.orderLineId) ?? 0)
        if (target.quantity > remaining) {
          throw new BadRequestException({
            code: 'over_refund',
            message: `Cannot refund ${target.quantity} of order line ${target.orderLineId} - only ${remaining} remain refundable`,
          })
        }

        // Same per-unit figure bill-core's computeSubtotal() folds into a
        // Bill's subtotal: unit price plus every selected modifier's price.
        const modifiersTotal = line.modifiers.reduce((sum, m) => sum + m.priceMinor, 0n)
        const unitPriceMinor = line.unitPriceMinor + modifiersTotal
        const amountMinor = unitPriceMinor * BigInt(target.quantity)
        subtotalMinor += amountMinor
        lineData.push({ orderLineId: target.orderLineId, quantity: target.quantity, unitPriceMinor, amountMinor })
      }

      // Correct tax reversal (CAP-9, updated for issue #103's real tax
      // engine): proportional to the bill's own actual tax rate - taken from
      // the bill's own subtotalMinor/taxMinor ratio rather than
      // re-deriving a rate from the tenant's (possibly-since-changed) tax
      // registration, the same allocation guest/bills' BillShare split
      // already uses for the identical reason (bills.service.ts here has no
      // sibling to that file's own comment, so it's restated: this is the
      // correct inverse of whatever rate actually produced bill.taxMinor,
      // composition scheme's 0% and AU's inclusive GST included, without
      // this module needing to know which one applied).
      const taxMinor = bill.subtotalMinor === 0n ? 0n : (subtotalMinor * bill.taxMinor) / bill.subtotalMinor

      // Refund is unconditionally gated (unlike finalize()'s above-threshold
      // discount) - validate the refund request itself first (cheap), then
      // spend a manager-PIN check only on a request that's actually valid.
      const approval = await this.managerAuth.authorize('refund', staff.tenantId, bill.outletId, dto.managerPin, dto.reason)

      const created = await tx.creditNote.create({
        data: {
          id: uuidv7(),
          tenantId: staff.tenantId,
          originalBillId: billId,
          reason: dto.reason,
          approvedByStaffId: approval.approverId,
          createdByStaffId: staff.id,
          subtotalMinor,
          taxMinor,
          lines: {
            create: lineData.map((l) => ({
              id: uuidv7(),
              tenantId: staff.tenantId,
              orderLineId: l.orderLineId,
              quantity: l.quantity,
              unitPriceMinor: l.unitPriceMinor,
              amountMinor: l.amountMinor,
            })),
          },
        },
        include: CREDIT_NOTE_INCLUDE,
      })

      await this.managerAuth.recordApproval(tx, approval, { actorId: staff.id, actorEmail: staff.name, occurredAt: new Date() })

      return toCreditNoteView(created, bill.pricesIncludeTax)
    })
  }
}
