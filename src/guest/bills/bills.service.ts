// qr-self-order/CAP-5 (issue #80, AD-18): "one order pipeline, many writers"
// extended to money - guest checkout raises and settles a REAL Bill/Tender
// (the same rows pos/bills writes), never a parallel guest money model.
// Bill creation and finalisation reuse pos/bills' exact core (createOrGetBillRecord/
// commitFinalize/createTenderRecord, imported through its scoped barrel,
// src/pos/bills/index.ts - see bill-core.ts's top comment for why that barrel
// exists and why a full NestJS DI reuse of BillsService would cycle the
// module graph). This file adds only what's genuinely guest-shaped: the
// per-guest BillShare breakdown, and the simulated-payment step (SPEC
// qr-self-order CAP-5's explicit non-goal - no real payment gateway).
//
// UJ-5's failed-split invariant (this story's acceptance narrative): a
// simulated failure writes nothing - the targeted share simply stays
// `outstanding` (see BillShare's schema comment) - so every other guest's
// already-paid share (a real Tender row) is untouched, and the bill cannot
// finalise while any share remains outstanding. A retry that succeeds
// completes it exactly like any other share.
import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common'
import type { Order, Prisma, TableSession } from '../../generated/prisma/client'
import { buildInvoiceView, commitFinalize, createOrGetBillRecord, createTenderRecord, loadBill, toBillView } from '../../pos/bills'
import type { BillWithTenders, InvoiceView } from '../../pos/bills'
import { GuestPrincipal, RegionRegistryService, uuidv7 } from '../../platform'
import { isSessionInactive } from '../sessions/sessions.service'
import { setTenantContext } from '../tenant-context'
import { BillShareView, GuestBillView, SimulatedPaymentDto } from './bills.dtos'

type Tx = Prisma.TransactionClient

async function loadOrderForSession(tx: Tx, tenantId: string, sessionId: string, orderId: string): Promise<Order> {
  const order = await tx.order.findUnique({ where: { id: orderId } })
  if (!order || order.tenantId !== tenantId || order.sessionId !== sessionId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such order' })
  }
  return order
}

/**
 * Guards against a staff-side close racing a guest checkout in progress -
 * same 410 convention every other guest endpoint uses (guest/orders'
 * loadActiveSession, guest/cart's). Called only where the session being
 * inactive is a genuine abort, never on the normal completion path: callers
 * that can legitimately observe `status: 'settled'` (payShare/payAll, once
 * their own bill.status === 'finalized' check above has already returned)
 * never reach this.
 */
async function assertSessionActive(tx: Tx, tenantId: string, sessionId: string): Promise<TableSession> {
  const session = await tx.tableSession.findUnique({ where: { id: sessionId } })
  if (!session || session.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such session' })
  }
  if (isSessionInactive(session)) {
    throw new GoneException({ code: 'session_closed', message: 'This table session has ended' })
  }
  return session
}

function toShareView(row: { guestId: string; guestName: string; amountMinor: bigint; status: BillShareView['status']; payerPhone: string | null; paidAt: Date | null }): BillShareView {
  return {
    guestId: row.guestId,
    guestName: row.guestName,
    amountMinor: Number(row.amountMinor),
    status: row.status,
    payerPhone: row.payerPhone,
    paidAt: row.paidAt?.toISOString() ?? null,
  }
}

@Injectable()
export class GuestBillsService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  /**
   * Creates the real Bill for a placed order (through pos/bills' shared
   * core, createdByStaffId null - see Bill.createdByStaffId's schema
   * comment) and splits its subtotal+tax across every distinct guest
   * attributed on the order's lines (OrderLine.guestId), proportional to
   * each guest's own line total - amounts sum EXACTLY to the bill total
   * (the last guest, in line order, absorbs any rounding remainder, so
   * nothing is dropped or double-counted).
   *
   * Issue #98: idempotent per orderId, same as the staff path
   * (bills.service.ts's createBill) - a second call for an order that
   * already has a Bill returns it (200, created:false) instead of 409,
   * shares included, rather than forcing a caller who got a stale 409 into
   * a second round-trip through GET orders/:orderId/bill below.
   */
  async createBill(guest: GuestPrincipal, orderId: string): Promise<{ view: GuestBillView; created: boolean }> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      await assertSessionActive(tx, guest.tenantId, guest.sessionId)
      const order = await loadOrderForSession(tx, guest.tenantId, guest.sessionId, orderId)

      const { bill, created } = await createOrGetBillRecord(tx, {
        tenantId: guest.tenantId,
        outletId: order.outletId,
        orderId,
        createdByStaffId: null,
        orderClosed: order.status === 'closed',
      })
      const shares = created ? await this.writeShares(tx, guest.tenantId, bill) : await this.loadShareViews(tx, bill.id)
      return { view: { ...toBillView(bill), shares }, created }
    })
  }

  async getBill(guest: GuestPrincipal, orderId: string): Promise<GuestBillView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const order = await loadOrderForSession(tx, guest.tenantId, guest.sessionId, orderId)
      const billRow = await tx.bill.findUnique({ where: { orderId: order.id } })
      if (!billRow) {
        throw new NotFoundException({ code: 'not_found', message: 'No bill exists yet for this order' })
      }
      const bill = await loadBill(tx, guest.tenantId, billRow.id)
      const shares = await this.loadShareViews(tx, bill.id)
      return { ...toBillView(bill), shares }
    })
  }

  /**
   * Issue #103: GET .../bills/:id/invoice - the same ownership check as
   * payShare/payAll below (loadBill by id, then confirm the bill's order
   * belongs to this guest's own session), not getBill's orderId-scoped
   * lookup, since the invoice is addressed by billId like those two.
   */
  async getInvoice(guest: GuestPrincipal, billId: string): Promise<InvoiceView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const bill = await loadBill(tx, guest.tenantId, billId)
      await loadOrderForSession(tx, guest.tenantId, guest.sessionId, bill.orderId)
      return buildInvoiceView(tx, guest.tenantId, billId)
    })
  }

  /**
   * The simulated payment step for one guest's share (SPEC qr-self-order
   * CAP-5's non-goal - see SimulatedPaymentDto). `success` records a real
   * Tender for exactly this share's amount and marks it paid; `failure`
   * writes nothing (UJ-5). Once every share on the bill is paid, the bill
   * finalises itself through the exact same commitFinalize the staff path
   * uses, and the table session settles (its lifecycle's normal end).
   */
  async payShare(guest: GuestPrincipal, billId: string, guestId: string, dto: SimulatedPaymentDto): Promise<GuestBillView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const bill = await loadBill(tx, guest.tenantId, billId)
      const order = await loadOrderForSession(tx, guest.tenantId, guest.sessionId, bill.orderId)
      if (bill.status === 'finalized') {
        throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
      }
      // Checked only after the finalized short-circuit above: a session that
      // legitimately reached 'settled' via this bill's own completion is not
      // an abort and must never mask 'already_finalized' with a 410 - only a
      // genuine staff close (or idle expiry) reaches this line.
      await assertSessionActive(tx, guest.tenantId, guest.sessionId)

      const share = await tx.billShare.findUnique({ where: { billId_guestId: { billId, guestId } } })
      if (!share || share.tenantId !== guest.tenantId) {
        throw new NotFoundException({ code: 'not_found', message: 'No such share on this bill' })
      }
      if (share.status === 'paid') {
        throw new ConflictException({ code: 'share_already_paid', message: 'This share has already been paid' })
      }

      if (dto.simulatedOutcome === 'success') {
        const tender = await createTenderRecord(tx, { tenantId: guest.tenantId, billId, method: 'upi_manual', amountMinor: share.amountMinor })
        await tx.billShare.update({
          where: { id: share.id },
          data: { status: 'paid', payerPhone: dto.payerPhone ?? null, tenderId: tender.id, paidAt: new Date() },
        })

        const stillOutstanding = await tx.billShare.count({ where: { billId, status: 'outstanding' } })
        if (stillOutstanding === 0) {
          await this.completeBill(tx, guest.tenantId, bill, order)
        }
      }
      // simulatedOutcome === 'failure': nothing written - the share stays
      // outstanding, every other guest's paid share (and its real Tender)
      // is untouched, and the bill cannot finalise (UJ-5).

      return this.buildView(tx, guest.tenantId, billId)
    })
  }

  /**
   * One-payment mode (Q6's alternative to per-guest split): a single
   * simulated payment for the bill's full total, one Tender, every share
   * marked paid together. Rejected if any share was already paid
   * individually - one-payment mode is a whole-bill choice, not a way to
   * mop up whatever a partial per-share flow left outstanding.
   */
  async payAll(guest: GuestPrincipal, billId: string, dto: SimulatedPaymentDto): Promise<GuestBillView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, guest.tenantId)
      const bill = await loadBill(tx, guest.tenantId, billId)
      const order = await loadOrderForSession(tx, guest.tenantId, guest.sessionId, bill.orderId)
      if (bill.status === 'finalized') {
        throw new ConflictException({ code: 'already_finalized', message: 'This bill has already been finalised' })
      }
      await assertSessionActive(tx, guest.tenantId, guest.sessionId)

      const shares = await tx.billShare.findMany({ where: { billId } })
      if (shares.some((s) => s.status === 'paid')) {
        throw new ConflictException({
          code: 'partial_payment_exists',
          message: 'One or more shares on this bill are already paid - pay the remaining shares individually',
        })
      }

      if (dto.simulatedOutcome === 'success') {
        const totalMinor = bill.subtotalMinor + bill.taxMinor
        const tender = await createTenderRecord(tx, { tenantId: guest.tenantId, billId, method: 'upi_manual', amountMinor: totalMinor })
        await tx.billShare.updateMany({
          where: { billId },
          data: { status: 'paid', payerPhone: dto.payerPhone ?? null, tenderId: tender.id, paidAt: new Date() },
        })
        await this.completeBill(tx, guest.tenantId, bill, order)
      }

      return this.buildView(tx, guest.tenantId, billId)
    })
  }

  private async writeShares(tx: Tx, tenantId: string, bill: BillWithTenders): Promise<BillShareView[]> {
    const lines = await tx.orderLine.findMany({ where: { orderId: bill.orderId }, include: { modifiers: true }, orderBy: { createdAt: 'asc' } })
    const totals = new Map<string, { guestName: string; lineTotal: bigint }>()
    for (const line of lines) {
      // Every qr-placed line carries a guestId (guest/orders' placeOrder) -
      // a missing one would mean a pos-source line on a guest bill, which
      // createOrGetBillRecord's own order lookup already makes impossible.
      if (!line.guestId) continue
      const modifiersTotal = line.modifiers.reduce((sum, m) => sum + m.priceMinor, 0n)
      const lineTotal = BigInt(line.quantity) * (line.unitPriceMinor + modifiersTotal)
      const existing = totals.get(line.guestId)
      if (existing) existing.lineTotal += lineTotal
      else totals.set(line.guestId, { guestName: line.guestName ?? 'Guest', lineTotal })
    }

    const guests = [...totals.entries()]
    let taxAllocated = 0n
    const views: BillShareView[] = []
    for (const [i, [guestId, { guestName, lineTotal }]] of guests.entries()) {
      const isLast = i === guests.length - 1
      // Proportional to this guest's share of the subtotal; the last guest
      // absorbs whatever integer division dropped, so the shares sum EXACTLY
      // to bill.taxMinor (and therefore to the bill's total) with no gap.
      const taxShare = isLast ? bill.taxMinor - taxAllocated : bill.subtotalMinor === 0n ? 0n : (lineTotal * bill.taxMinor) / bill.subtotalMinor
      taxAllocated += taxShare
      const amountMinor = lineTotal + taxShare

      await tx.billShare.create({
        data: { id: uuidv7(), tenantId, billId: bill.id, guestId, guestName, amountMinor },
      })
      views.push({ guestId, guestName, amountMinor: Number(amountMinor), status: 'outstanding', payerPhone: null, paidAt: null })
    }
    return views
  }

  private async loadShareViews(tx: Tx, billId: string): Promise<BillShareView[]> {
    const rows = await tx.billShare.findMany({ where: { billId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toShareView)
  }

  private async buildView(tx: Tx, tenantId: string, billId: string): Promise<GuestBillView> {
    const bill = await loadBill(tx, tenantId, billId)
    const shares = await this.loadShareViews(tx, billId)
    return { ...toBillView(bill), shares }
  }

  /**
   * Every outstanding share just reached paid - finalise the bill through
   * the exact reserve-then-commit path pos/bills' staff finalize() uses (no
   * discount, no staff finalizer), then settle the table session per its
   * lifecycle (qr-self-order CAP-1's "expires on bill settlement" end).
   */
  private async completeBill(tx: Tx, tenantId: string, bill: BillWithTenders, order: Order): Promise<void> {
    await commitFinalize(tx, { tenantId, bill, discountMinor: null, discountReason: null, finalizedByStaffId: null })
    if (order.sessionId) {
      await tx.tableSession.update({ where: { id: order.sessionId }, data: { status: 'settled', closedAt: new Date() } })
    }
  }
}
