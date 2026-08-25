// pos/CAP-7 bill & settle (AD-14). Finalises an Order (built by pos/CAP-2's
// orders.service.ts and pos/CAP-3's order-lines.service.ts, both reused
// as-is - loadOrder/assertOwner are imported, not reimplemented) into an
// immutable Bill. See prisma/schema.prisma's Bill/Tender/BillNumberCounter
// comment block for the insert-only-past-finalisation and reserve-then-
// commit numbering invariants this service must uphold.
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
// Tax: no per-item, per-category, or per-tenant tax-rate field exists
// anywhere in the schema (checked admin/menu's ItemPrice/MenuItem/
// MenuCategory and Tenant/TenantTaxRegistration - the latter carries a
// registration profile string, not a rate). Per this story's brief, a flat
// placeholder rate is applied instead of inventing a fake per-item tax
// field: see TAX_RATE_PLACEHOLDER below. A future tax-configuration story
// owns making this a real, tenant-configurable rate.
//
// Discount-above-threshold: routes through platform/manager-auth
// (ManagerAuthService), per stories.yaml's explicit instruction, rather than
// accepting a bare reason string. SPEC.md's Assumptions section has no
// concrete default threshold value (still an open question there); this
// story picks 20% of the bill's subtotal, the example the spec's own memlog
// floated ("any discount over 20%") - see DISCOUNT_THRESHOLD_FRACTION.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '../../generated/prisma/client'
import { ManagerApproval, ManagerAuthService, PosPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { setTenantContext } from '../tenant-context'
import { assertOwner, loadOrder } from '../orders/orders.service'
import { FinalizeBillDto, BillView, TenderView } from './bills.dtos'

type Tx = Prisma.TransactionClient

// TODO(tax-configuration story): replace with a real per-tenant/per-item tax
// rate once one exists anywhere in the schema. 5% is a documented, flat
// placeholder - not a real GST/VAT figure for any jurisdiction - chosen only
// so bills carry a non-zero, deterministic tax breakdown until that story
// lands.
const TAX_RATE_PLACEHOLDER_PERCENT = 5n

// SPEC.md's Assumptions section defers the actual discount-above-threshold
// value to "a sane default...pending a real settings field" - this story's
// memlog names "any discount over 20%" as that default. TODO(tenant
// settings story): make this a real per-tenant configurable value.
const DISCOUNT_THRESHOLD_PERCENT = 20n

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

const BILL_INCLUDE = { tenders: { orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.BillInclude
type BillWithTenders = Prisma.BillGetPayload<{ include: typeof BILL_INCLUDE }>

function toTenderView(t: BillWithTenders['tenders'][number]): TenderView {
  return { id: t.id, method: t.method, amountMinor: Number(t.amountMinor), createdAt: t.createdAt.toISOString() }
}

function toBillView(bill: BillWithTenders): BillView {
  const discountMinor = bill.discountMinor ?? 0n
  return {
    id: bill.id,
    tenantId: bill.tenantId,
    outletId: bill.outletId,
    orderId: bill.orderId,
    billNumber: bill.billNumber,
    subtotalMinor: Number(bill.subtotalMinor),
    taxMinor: Number(bill.taxMinor),
    discountMinor: bill.discountMinor === null ? null : Number(bill.discountMinor),
    discountReason: bill.discountReason,
    totalMinor: Number(bill.subtotalMinor + bill.taxMinor - discountMinor),
    status: bill.status,
    createdByStaffId: bill.createdByStaffId,
    createdAt: bill.createdAt.toISOString(),
    finalizedByStaffId: bill.finalizedByStaffId,
    finalizedAt: bill.finalizedAt?.toISOString() ?? null,
    tenders: bill.tenders.map(toTenderView),
  }
}

async function loadBill(tx: Tx, tenantId: string, billId: string): Promise<BillWithTenders> {
  const bill = await tx.bill.findUnique({ where: { id: billId }, include: BILL_INCLUDE })
  if (!bill || bill.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such bill' })
  }
  return bill
}

/** Sums a bill's snapshotted lines (unit price + selected modifiers, times quantity) into subtotalMinor. */
async function computeSubtotal(tx: Tx, orderId: string): Promise<bigint> {
  const lines = await tx.orderLine.findMany({ where: { orderId }, include: { modifiers: true } })
  let subtotal = 0n
  for (const line of lines) {
    const modifiersTotal = line.modifiers.reduce((sum, m) => sum + m.priceMinor, 0n)
    subtotal += BigInt(line.quantity) * (line.unitPriceMinor + modifiersTotal)
  }
  return subtotal
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
   * already be closed: "sent" is the usual dine-in path (fired to the
   * kitchen already), but "open" is accepted too so a future QSR/counter
   * flow (pos/CAP-6, which the architecture map composes directly over this
   * module) can bill an order that never needed a kitchen-fire step. Only
   * one Bill may ever exist per order (schema-enforced, unique orderId) -
   * recomputing an open Bill after further order edits is out of scope for
   * this story; a second create attempt is rejected, not merged.
   */
  async createBill(staff: PosPrincipal, orderId: string): Promise<BillView> {
    const plane = this.plane()
    try {
      return await plane.$transaction(async (tx) => {
        await setTenantContext(tx, staff.tenantId)
        const order = await loadOrder(tx, staff.tenantId, orderId)
        await assertOwner(tx, order, staff)

        if (order.status === 'closed') {
          throw new ConflictException({ code: 'conflict', message: 'This order is already closed' })
        }

        const existing = await tx.bill.findUnique({ where: { orderId } })
        if (existing) {
          throw new ConflictException({ code: 'bill_already_exists', message: 'A bill already exists for this order' })
        }

        const subtotalMinor = await computeSubtotal(tx, orderId)
        const taxMinor = (subtotalMinor * TAX_RATE_PLACEHOLDER_PERCENT) / 100n

        const bill = await tx.bill.create({
          data: {
            id: uuidv7(),
            tenantId: staff.tenantId,
            outletId: order.outletId,
            orderId,
            subtotalMinor,
            taxMinor,
            createdByStaffId: staff.id,
          },
          include: BILL_INCLUDE,
        })
        return toBillView(bill)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({ code: 'bill_already_exists', message: 'A bill already exists for this order' })
      }
      throw error
    }
  }

  async getBill(staff: PosPrincipal, billId: string): Promise<BillView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const bill = await loadBill(tx, staff.tenantId, billId)
      return toBillView(bill)
    })
  }

  /**
   * Validates discount/tender inputs, routes a discount above
   * DISCOUNT_THRESHOLD_PERCENT through platform/manager-auth (AD-15),
   * reserves the next gapless bill number, and writes everything (Bill,
   * Tenders, the manager-auth audit row, and the Order's closed status) in
   * one transaction. Not owner-only, unlike createBill: a cashier settling
   * at a register is frequently not the waiter who owns the order, and
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

      const totalMinor = bill.subtotalMinor + bill.taxMinor - (discountMinor ?? 0n)
      const tenderTotal = dto.tenders.reduce((sum, t) => sum + BigInt(t.amountMinor), 0n)
      if (tenderTotal !== totalMinor) {
        throw new BadRequestException({
          code: 'tender_mismatch',
          message: `Tenders sum to ${tenderTotal} but the bill total is ${totalMinor}`,
        })
      }

      // Reserve-then-commit (AD-14): the counter is touched only now, after
      // every validation above has already passed, and only inside this same
      // transaction - a validation failure earlier never reserves a number,
      // and if anything below still fails, the whole transaction (counter
      // increment included) rolls back with it. Either way, no gap.
      const counter = await tx.billNumberCounter.upsert({
        where: { outletId: bill.outletId },
        create: { id: uuidv7(), tenantId: staff.tenantId, outletId: bill.outletId, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      })

      // Compare-and-swap on status, not a plain update-by-id: if a concurrent
      // request already finalised this bill between the read above and here,
      // this affects zero rows instead of silently double-finalising it.
      const updated = await tx.bill.updateMany({
        where: { id: billId, status: 'open' },
        data: {
          billNumber: counter.lastNumber,
          discountMinor,
          discountReason,
          status: 'finalized',
          finalizedByStaffId: staff.id,
          finalizedAt: new Date(),
        },
      })
      if (updated.count === 0) {
        throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
      }

      for (const tender of dto.tenders) {
        await tx.tender.create({
          data: { id: uuidv7(), tenantId: staff.tenantId, billId, method: tender.method, amountMinor: BigInt(tender.amountMinor) },
        })
      }

      // pos/CAP-2's comment on Order.status calls this out explicitly:
      // "closed" was a placeholder ahead of this exact story - finalising a
      // Bill is what actually closes the order, written directly (not
      // through orders.service.ts's FORWARD_TRANSITIONS-checked updateStatus)
      // since that guard is for staff-driven transitions, not this one.
      await tx.order.update({ where: { id: bill.orderId }, data: { status: 'closed' } })

      if (approval) {
        await this.managerAuth.recordApproval(tx, approval, { actorId: staff.id, actorEmail: staff.name, occurredAt: new Date() })
      }

      const final = await loadBill(tx, staff.tenantId, billId)
      return toBillView(final)
    })
  }
}
