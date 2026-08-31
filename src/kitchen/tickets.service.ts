// kitchen-display/CAP-1..5 (issue #67, AD-16): the ticket domain's sole
// owner. Two kinds of entry points into this file:
//
//  - fireOnSend/fireAddedLine take a caller-supplied `tx` and participate in
//    the CALLER's transaction (pos/orders' open->sent transition and
//    pos/order-lines' addLine, per AD-16's "same transaction" rule) - they
//    open no transaction of their own.
//  - everything else (bump/recall/refire, the station/expo/bumped/all-day
//    reads, the stations picker) is a normal pos-realm action/read that
//    opens its own transaction, same shape as every pos/admin service.
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Order, OrderLine, Prisma, Station } from '../generated/prisma/client'
import { PosPrincipal, RegionRegistryService } from '../platform'
import { setTenantContext } from './tenant-context'
import { AllDaySummaryEntryView, ExpoOrderView, ExpoStationEntryView, StationView, TicketLineView, TicketView } from './tickets.dtos'

export type Tx = Prisma.TransactionClient

export interface BumpedTicketView extends TicketView {
  // ISO timestamps of every recall this ticket has been through (CAP-4: "the
  // bumped view retains it with its recall history") - read from the
  // append-only TicketEvent log, not derived from the single recallCount/
  // recalledAt pair on Ticket itself.
  recallHistory: string[]
}

async function loadOutlet(tx: Tx, tenantId: string, outletId: string): Promise<void> {
  const outlet = await tx.outlet.findUnique({ where: { id: outletId } })
  if (!outlet || outlet.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such outlet' })
  }
}

async function loadTicket(tx: Tx, tenantId: string, ticketId: string) {
  const ticket = await tx.ticket.findUnique({ where: { id: ticketId } })
  if (!ticket || ticket.tenantId !== tenantId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such ticket' })
  }
  return ticket
}

// Routing default (documented choice, per issue #67 scope): the outlet's
// oldest non-deleted station. Zero stations at the outlet -> null, the
// synthetic "unrouted" grouping - firing still succeeds rather than failing
// the order (SPEC CAP-1 constraint).
async function resolveDefaultStationId(tx: Tx, tenantId: string, outletId: string): Promise<string | null> {
  const station = await tx.station.findFirst({ where: { tenantId, outletId, deletedAt: null }, orderBy: { createdAt: 'asc' } })
  return station?.id ?? null
}

// The public "station id" path segment for the unrouted synthetic grouping -
// there is no real Station row to address it by, since Ticket.stationId is
// nullable precisely for this case.
export const UNROUTED_STATION_PARAM = 'unrouted'

/** Resolves a `:stationId` path param (a real station id, or the literal "unrouted") to the DB value, validating outlet ownership. */
export async function resolveStationParam(tx: Tx, tenantId: string, outletId: string, stationIdParam: string): Promise<string | null> {
  if (stationIdParam === UNROUTED_STATION_PARAM) return null
  const station = await tx.station.findUnique({ where: { id: stationIdParam } })
  if (!station || station.tenantId !== tenantId || station.outletId !== outletId) {
    throw new NotFoundException({ code: 'not_found', message: 'No such station for this outlet' })
  }
  return station.id
}

const TICKET_LINE_INCLUDE = {
  orderLine: {
    include: {
      item: true,
      variant: true,
      modifiers: { include: { modifier: true } },
    },
  },
} satisfies Prisma.TicketLineInclude

type TicketLineWithOrderLine = Prisma.TicketLineGetPayload<{ include: typeof TICKET_LINE_INCLUDE }>

function toTicketLineView(line: TicketLineWithOrderLine): TicketLineView {
  return {
    id: line.id,
    orderLineId: line.orderLineId,
    itemId: line.orderLine.itemId,
    itemName: line.orderLine.item.shortName,
    variantName: line.orderLine.variant?.name ?? null,
    quantity: line.quantity,
    seatNumber: line.orderLine.seatNumber,
    guestName: line.orderLine.guestName,
    modifiers: line.orderLine.modifiers.map((m) => ({ id: m.id, name: m.modifier.name })),
    addOnBatch: line.addOnBatch,
    voided: line.voided,
  }
}

async function buildTicketView(tx: Tx, ticket: { id: string; orderId: string; stationId: string | null; status: string; firedAt: Date; bumpedAt: Date | null; recallCount: number }): Promise<TicketView> {
  const [lines, station, order] = await Promise.all([
    tx.ticketLine.findMany({ where: { ticketId: ticket.id }, include: TICKET_LINE_INCLUDE, orderBy: { createdAt: 'asc' } }),
    ticket.stationId ? tx.station.findUnique({ where: { id: ticket.stationId } }) : Promise.resolve(null),
    tx.order.findUnique({ where: { id: ticket.orderId }, include: { table: true } }),
  ])
  return {
    id: ticket.id,
    orderId: ticket.orderId,
    stationId: ticket.stationId,
    stationName: station?.name ?? null,
    tableLabel: order?.table?.label ?? null,
    tokenNumber: order?.tokenNumber ?? null,
    status: ticket.status as TicketView['status'],
    firedAt: ticket.firedAt.toISOString(),
    bumpedAt: ticket.bumpedAt?.toISOString() ?? null,
    recallCount: ticket.recallCount,
    // A ticket can only re-enter "queued" from "bumped" via recall() below,
    // so this pair alone is sufficient to mean "currently sitting in queue
    // because it was recalled" - no extra column needed.
    recalled: ticket.status === 'queued' && ticket.recallCount > 0,
    lines: lines.map(toTicketLineView),
  }
}

@Injectable()
export class KitchenTicketsService {
  constructor(private readonly registry: RegionRegistryService) {}

  private plane() {
    return this.registry.planeFor(this.registry.homeRegion())
  }

  // -- fire hook (invoked from pos/orders and pos/order-lines, same tx) -----

  /**
   * Whole-order fire (pos/CAP-2's open->sent transition): every line on the
   * order is unfired at this point (the order was "open"), so every line is
   * grouped by resolved station and ticketed in one pass - one ticket per
   * station, addOnBatch 0. A no-op if the order somehow has no lines yet.
   */
  async fireOnSend(tx: Tx, order: Pick<Order, 'id' | 'tenantId' | 'outletId'>): Promise<void> {
    const lines = await tx.orderLine.findMany({ where: { orderId: order.id }, include: { item: true } })
    if (lines.length === 0) return

    const defaultStationId = await resolveDefaultStationId(tx, order.tenantId, order.outletId)
    const groups = new Map<string | null, typeof lines>()
    for (const line of lines) {
      const stationId = line.item.stationId ?? defaultStationId
      const group = groups.get(stationId)
      if (group) group.push(line)
      else groups.set(stationId, [line])
    }

    for (const [stationId, groupLines] of groups) {
      const ticket = await tx.ticket.create({ data: { tenantId: order.tenantId, outletId: order.outletId, orderId: order.id, stationId } })
      for (const line of groupLines) {
        await tx.ticketLine.create({ data: { tenantId: order.tenantId, ticketId: ticket.id, orderLineId: line.id, quantity: line.quantity, addOnBatch: 0 } })
      }
    }
  }

  /**
   * A single new line added to an already-"sent" order (pos/CAP-3's addLine
   * allows this - see order-lines.service.ts's assertOrderNotClosed, not
   * assertOrderOpenForEdit). Appends an ADD-ON batch to the station's
   * existing QUEUED ticket; opens a brand-new ticket at that station only if
   * there is no ticket there yet, or the prior one there was already bumped
   * (documented edge, issue #67 scope) - never a second ticket alongside a
   * still-queued one.
   */
  async fireAddedLine(tx: Tx, order: Pick<Order, 'id' | 'tenantId' | 'outletId'>, line: Pick<OrderLine, 'id' | 'quantity'> & { item: { stationId: string | null } }): Promise<void> {
    const defaultStationId = await resolveDefaultStationId(tx, order.tenantId, order.outletId)
    const stationId = line.item.stationId ?? defaultStationId

    const existing = await tx.ticket.findFirst({ where: { orderId: order.id, stationId }, orderBy: { firedAt: 'desc' } })
    if (existing && existing.status === 'queued') {
      const maxBatch = await tx.ticketLine.aggregate({ where: { ticketId: existing.id }, _max: { addOnBatch: true } })
      const nextBatch = (maxBatch._max.addOnBatch ?? 0) + 1
      await tx.ticketLine.create({ data: { tenantId: order.tenantId, ticketId: existing.id, orderLineId: line.id, quantity: line.quantity, addOnBatch: nextBatch } })
      await tx.ticketEvent.create({ data: { tenantId: order.tenantId, ticketId: existing.id, type: 'add_on_fired' } })
      return
    }

    const ticket = await tx.ticket.create({ data: { tenantId: order.tenantId, outletId: order.outletId, orderId: order.id, stationId } })
    await tx.ticketLine.create({ data: { tenantId: order.tenantId, ticketId: ticket.id, orderLineId: line.id, quantity: line.quantity, addOnBatch: 0 } })
  }

  // -- actions (CAP-2/CAP-4, no actor attribution) --------------------------

  async bump(staff: PosPrincipal, ticketId: string): Promise<TicketView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const ticket = await loadTicket(tx, staff.tenantId, ticketId)
      if (ticket.status === 'bumped') {
        throw new ConflictException({ code: 'conflict', message: 'This ticket is already bumped' })
      }
      const updated = await tx.ticket.update({ where: { id: ticketId }, data: { status: 'bumped', bumpedAt: new Date() } })
      await tx.ticketEvent.create({ data: { tenantId: staff.tenantId, ticketId, type: 'bumped' } })
      return buildTicketView(tx, updated)
    })
  }

  /** Returns a bumped ticket to its source station's queue, marked RECALLED (CAP-4). */
  async recall(staff: PosPrincipal, ticketId: string): Promise<TicketView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      const ticket = await loadTicket(tx, staff.tenantId, ticketId)
      if (ticket.status !== 'bumped') {
        throw new ConflictException({ code: 'conflict', message: 'Only a bumped ticket can be recalled' })
      }
      const updated = await tx.ticket.update({
        where: { id: ticketId },
        data: { status: 'queued', recallCount: { increment: 1 }, recalledAt: new Date() },
      })
      await tx.ticketEvent.create({ data: { tenantId: staff.tenantId, ticketId, type: 'recalled' } })
      return buildTicketView(tx, updated)
    })
  }

  /**
   * Force-resends a ticket to its station's queue - distinct from recall()
   * (issue #67 scope names both endpoints without defining "refire";
   * documented design decision): no RECALLED marker, no recallCount change,
   * firedAt untouched so the ageing clock is not reset, and unlike recall()
   * it is not conditioned on the ticket currently being bumped (a queued
   * ticket can be force-resent too, a no-op status-wise but still logged).
   */
  async refire(staff: PosPrincipal, ticketId: string): Promise<TicketView> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadTicket(tx, staff.tenantId, ticketId)
      const updated = await tx.ticket.update({ where: { id: ticketId }, data: { status: 'queued', bumpedAt: null } })
      await tx.ticketEvent.create({ data: { tenantId: staff.tenantId, ticketId, type: 'refired' } })
      return buildTicketView(tx, updated)
    })
  }

  // -- reads (CAP-2/CAP-3/CAP-4/CAP-5) --------------------------------------

  async listStations(staff: PosPrincipal, outletId: string): Promise<StationView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)
      const stations = await tx.station.findMany({ where: { tenantId: staff.tenantId, outletId, deletedAt: null }, orderBy: { createdAt: 'asc' } })
      return stations.map(toStationView)
    })
  }

  /** CAP-2: queued tickets for one station, oldest-left (firedAt asc) so ageing reads left-to-right. */
  async stationQueue(staff: PosPrincipal, outletId: string, stationIdParam: string): Promise<TicketView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)
      const stationId = await resolveStationParam(tx, staff.tenantId, outletId, stationIdParam)
      const tickets = await tx.ticket.findMany({ where: { tenantId: staff.tenantId, outletId, stationId, status: 'queued' }, orderBy: { firedAt: 'asc' } })
      return Promise.all(tickets.map((t) => buildTicketView(tx, t)))
    })
  }

  /** CAP-3: every order with at least one ticket, re-consolidated across stations, plus its Waiting-On panel. */
  async expo(staff: PosPrincipal, outletId: string): Promise<ExpoOrderView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)

      // Expo cares about every order still in flight to the kitchen - "sent"
      // covers it exactly (an order leaves expo only once closed, matching
      // the SPEC's "plates leave together" framing rather than vanishing the
      // moment the last station bumps).
      const orders = await tx.order.findMany({ where: { tenantId: staff.tenantId, outletId, status: 'sent' }, include: { table: true }, orderBy: { createdAt: 'asc' } })

      const result: ExpoOrderView[] = []
      for (const order of orders) {
        const tickets = await tx.ticket.findMany({ where: { orderId: order.id }, orderBy: { firedAt: 'asc' } })
        if (tickets.length === 0) continue

        const views = await Promise.all(tickets.map((t) => buildTicketView(tx, t)))
        const byStation = new Map<string, TicketView[]>()
        for (const view of views) {
          const key = view.stationId ?? UNROUTED_STATION_PARAM
          const group = byStation.get(key)
          if (group) group.push(view)
          else byStation.set(key, [view])
        }

        const stations: ExpoStationEntryView[] = [...byStation.entries()].map(([key, ticketsAtStation]) => ({
          stationId: key === UNROUTED_STATION_PARAM ? null : key,
          stationName: ticketsAtStation[0]?.stationName ?? null,
          ready: ticketsAtStation.every((t) => t.status === 'bumped'),
          tickets: ticketsAtStation,
        }))
        const waitingOn = views.filter((t) => t.status === 'queued').flatMap((t) => t.lines.filter((l) => !l.voided))

        result.push({ orderId: order.id, tableLabel: order.table?.label ?? null, tokenNumber: order.tokenNumber, stations, waitingOn })
      }
      return result
    })
  }

  /** CAP-4: bumped tickets, most-recently-bumped first, each with its full recall history. */
  async bumped(staff: PosPrincipal, outletId: string): Promise<BumpedTicketView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)
      const tickets = await tx.ticket.findMany({ where: { tenantId: staff.tenantId, outletId, status: 'bumped' }, orderBy: { bumpedAt: 'desc' } })
      return Promise.all(
        tickets.map(async (ticket) => {
          const [view, events] = await Promise.all([
            buildTicketView(tx, ticket),
            tx.ticketEvent.findMany({ where: { ticketId: ticket.id, type: 'recalled' }, orderBy: { occurredAt: 'asc' } }),
          ])
          return { ...view, recallHistory: events.map((e) => e.occurredAt.toISOString()) }
        }),
      )
    })
  }

  /** CAP-5: per-item live counts derived only from real queued, non-voided ticket lines - never fabricated. */
  async allDaySummary(staff: PosPrincipal, outletId: string): Promise<AllDaySummaryEntryView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)
      const lines = await tx.ticketLine.findMany({
        where: { tenantId: staff.tenantId, voided: false, ticket: { outletId, status: 'queued' } },
        include: { orderLine: { include: { item: true } } },
      })
      const totals = new Map<string, AllDaySummaryEntryView>()
      for (const line of lines) {
        const itemId = line.orderLine.itemId
        const entry = totals.get(itemId) ?? { itemId, itemName: line.orderLine.item.shortName, quantity: 0 }
        entry.quantity += line.quantity
        totals.set(itemId, entry)
      }
      return [...totals.values()].sort((a, b) => a.itemName.localeCompare(b.itemName))
    })
  }
}

function toStationView(station: Pick<Station, 'id' | 'name' | 'ageingThresholdMinutes'>): StationView {
  return { id: station.id, name: station.name, ageingThresholdMinutes: station.ageingThresholdMinutes }
}
