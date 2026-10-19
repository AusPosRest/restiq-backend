// kitchen-display/CAP-1..5 (issue #67, AD-16): the ticket domain's sole
// owner. Two kinds of entry points into this file:
//
//  - fireOnSend takes a caller-supplied `tx` and participate in
//    the CALLER's transaction (pos/orders' open->sent transition and
//    pos/order-lines' addLine, per AD-16's "same transaction" rule) - they
//    open no transaction of their own.
//  - everything else (bump/recall/refire, the station/expo/bumped/all-day
//    reads, the stations picker) is a normal pos-realm action/read that
//    opens its own transaction, same shape as every pos/admin service.
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Order, Prisma, Station } from '../generated/prisma/client'
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

// PE-21: an item routes to one station, but stations belong to an outlet. At
// another outlet (or once that station is deleted) the item goes to the
// station there with the same name, else the outlet's default - never to a
// screen in a different outlet.
async function routeStationId(tx: Tx, order: Pick<Order, 'outletId'>, itemStationId: string | null, defaultStationId: string | null): Promise<string | null> {
  if (!itemStationId) return defaultStationId
  const station = await tx.station.findUnique({ where: { id: itemStationId } })
  if (!station) return defaultStationId
  if (station.outletId === order.outletId && !station.deletedAt) return station.id
  const sameName = await tx.station.findFirst({ where: { tenantId: station.tenantId, outletId: order.outletId, name: station.name, deletedAt: null } })
  return sameName?.id ?? defaultStationId
}

// The public "station id" path segment for the unrouted synthetic grouping -
// there is no real Station row to address it by, since Ticket.stationId is
// nullable precisely for this case.
export const UNROUTED_STATION_PARAM = 'unrouted'

/**
 * How far back the Done tab looks (issue #167). A rolling window, not "since
 * midnight", so a service running past midnight keeps its own tickets on
 * screen; reopening is limited to the same window, since a ticket bumped
 * yesterday has no business going back on a live station board.
 */
const BUMPED_WINDOW_MS = 12 * 60 * 60 * 1000
// CU-20: the same window bounds what is still live. A ticket fired more than
// 12 hours ago and never bumped is a leftover (yesterday's unclosed order),
// not food anyone is cooking - it stays in the data but leaves the boards.
const LIVE_WINDOW_MS = BUMPED_WINDOW_MS
const liveSince = (): Date => new Date(Date.now() - LIVE_WINDOW_MS)
const BUMPED_MAX = 200

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
      parentLine: { select: { combo: { select: { name: true } } } },
    },
  },
} satisfies Prisma.TicketLineInclude

type TicketLineWithOrderLine = Prisma.TicketLineGetPayload<{ include: typeof TICKET_LINE_INCLUDE }>

function toTicketLineView(line: TicketLineWithOrderLine): TicketLineView {
  return {
    id: line.id,
    orderLineId: line.orderLineId,
    // Only item lines are ever ticketed (fireOnSend skips combo parents).
    itemId: line.orderLine.itemId ?? '',
    itemName: line.orderLine.item?.shortName ?? '',
    variantName: line.orderLine.variant?.name ?? null,
    comboName: line.orderLine.parentLine?.combo?.name ?? null,
    quantity: line.quantity,
    seatNumber: line.orderLine.seatNumber,
    guestName: line.orderLine.guestName,
    modifiers: line.orderLine.modifiers.map((m) => ({ id: m.id, name: m.modifier.name })),
    addOnBatch: line.addOnBatch,
    voided: line.voided,
    // restiq-backend#210: the till's special instructions for this line.
    note: line.orderLine.note,
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
   * Fires every line on the order the kitchen doesn't have yet, grouped by
   * resolved station (pos/CAP-2's open->sent transition, guest placement,
   * and - restiq-backend#210 - a later "Send to kitchen" for items added to an
   * already-sent order, plus finalize as a backstop so a paid order always
   * reaches the kitchen). Per station: appended as the next ADD-ON batch to
   * that station's still-QUEUED ticket, or a brand-new ticket (batch 0) when
   * there is none or the last one there was already bumped (documented edge,
   * issue #67 scope). Voided lines never fire. Returns how many lines fired.
   */
  async fireOnSend(tx: Tx, order: Pick<Order, 'id' | 'tenantId' | 'outletId'>): Promise<number> {
    // A combo's parent line has no item and nothing to cook - its child lines
    // (the chosen items) are what the kitchen gets (restiq-backend#160).
    const lines = (
      await tx.orderLine.findMany({ where: { orderId: order.id, voidedAt: null, ticketLines: { none: {} } }, include: { item: true }, orderBy: { createdAt: 'asc' } })
    ).flatMap((l) => (l.item ? [{ ...l, item: l.item }] : []))
    if (lines.length === 0) return 0

    const defaultStationId = await resolveDefaultStationId(tx, order.tenantId, order.outletId)
    const groups = new Map<string | null, typeof lines>()
    for (const line of lines) {
      const stationId = await routeStationId(tx, order, line.item.stationId, defaultStationId)
      const group = groups.get(stationId)
      if (group) group.push(line)
      else groups.set(stationId, [line])
    }

    for (const [stationId, groupLines] of groups) {
      const existing = await tx.ticket.findFirst({ where: { orderId: order.id, stationId }, orderBy: { firedAt: 'desc' } })
      let ticketId: string
      let addOnBatch = 0
      if (existing && existing.status === 'queued') {
        const maxBatch = await tx.ticketLine.aggregate({ where: { ticketId: existing.id }, _max: { addOnBatch: true } })
        ticketId = existing.id
        addOnBatch = (maxBatch._max.addOnBatch ?? 0) + 1
        await tx.ticketEvent.create({ data: { tenantId: order.tenantId, ticketId, type: 'add_on_fired' } })
      } else {
        ticketId = (await tx.ticket.create({ data: { tenantId: order.tenantId, outletId: order.outletId, orderId: order.id, stationId } })).id
      }
      for (const line of groupLines) {
        await tx.ticketLine.create({ data: { tenantId: order.tenantId, ticketId, orderLineId: line.id, quantity: line.quantity, addOnBatch } })
      }
    }
    return lines.length
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
      if (ticket.bumpedAt && Date.now() - ticket.bumpedAt.getTime() > BUMPED_WINDOW_MS) {
        throw new ConflictException({ code: 'conflict', message: 'This ticket is too old to reopen' })
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
      const tickets = await tx.ticket.findMany({ where: { tenantId: staff.tenantId, outletId, stationId, status: 'queued', firedAt: { gte: liveSince() } }, orderBy: { firedAt: 'asc' } })
      return Promise.all(tickets.map((t) => buildTicketView(tx, t)))
    })
  }

  /** CAP-3: every order with at least one ticket, re-consolidated across stations, plus its Waiting-On panel. */
  async expo(staff: PosPrincipal, outletId: string): Promise<ExpoOrderView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)

      // Expo cares about every order still in flight to the kitchen: a "sent"
      // order stays until closed (the SPEC's "plates leave together"), and
      // SE-17: an order already paid and closed (pay-first counter/QSR, or a
      // QR table that settled early) stays while any ticket is still queued.
      // CU-20: only orders with a ticket fired inside the live window.
      // restiq-backend#243 (AP-cu-5): a paid order whose tickets are all
      // bumped stays as Ready for the Done tab's window so the runner can
      // call the token. Paid = finalized bill with no refund; a discarded
      // (cancelled) order has no bill, so it drops off as before.
      const since = liveSince()
      const orders = await tx.order.findMany({
        where: {
          tenantId: staff.tenantId,
          outletId,
          tickets: { some: { firedAt: { gte: since } } },
          OR: [
            { status: 'sent' },
            { tickets: { some: { status: 'queued' } } },
            {
              bill: { status: 'finalized', creditNotes: { none: {} } },
              tickets: { every: { status: 'bumped', bumpedAt: { gte: new Date(Date.now() - BUMPED_WINDOW_MS) } } },
            },
          ],
        },
        include: { table: true },
        orderBy: { createdAt: 'asc' },
      })

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

  /** CAP-4: bumped tickets in the last 12 hours, most-recently-bumped first, capped at 200. Each with its full recall history. */
  async bumped(staff: PosPrincipal, outletId: string): Promise<BumpedTicketView[]> {
    const plane = this.plane()
    return plane.$transaction(async (tx) => {
      await setTenantContext(tx, staff.tenantId)
      await loadOutlet(tx, staff.tenantId, outletId)
      const tickets = await tx.ticket.findMany({
        where: { tenantId: staff.tenantId, outletId, status: 'bumped', bumpedAt: { gte: new Date(Date.now() - BUMPED_WINDOW_MS) } },
        orderBy: { bumpedAt: 'desc' },
        take: BUMPED_MAX,
      })
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
        where: { tenantId: staff.tenantId, voided: false, ticket: { outletId, status: 'queued', firedAt: { gte: liveSince() } } },
        include: { orderLine: { include: { item: true } } },
      })
      const totals = new Map<string, AllDaySummaryEntryView>()
      for (const line of lines) {
        const item = line.orderLine.item
        if (!item) continue
        const itemId = item.id
        const entry = totals.get(itemId) ?? { itemId, itemName: item.shortName, quantity: 0 }
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
