// kitchen-display/CAP-1..5 (issue #67, AD-16) read/response shapes. No
// bump/recall/refire request body: these are shared-station-screen actions
// with no actor attribution (SPEC open question, resolved "no" - FR-34) and
// no parameters beyond the ticket id in the URL.

export interface StationView {
  id: string
  name: string
  ageingThresholdMinutes: number
}

export interface TicketLineModifierView {
  id: string
  name: string
}

// One fired line on a ticket. seatNumber/modifiers/variantName give the
// station cook everything needed to make the item without a second lookup;
// addOnBatch/voided are what let the client render ADD-ON section
// separation and struck-through void lines (CAP-1/CAP-2 success criteria).
export interface TicketLineView {
  id: string
  orderLineId: string
  itemId: string
  itemName: string
  variantName: string | null
  quantity: number
  seatNumber: number | null
  modifiers: TicketLineModifierView[]
  addOnBatch: number
  voided: boolean
}

export interface TicketView {
  id: string
  orderId: string
  stationId: string | null
  stationName: string | null
  tableLabel: string | null
  tokenNumber: number | null
  status: 'queued' | 'bumped'
  firedAt: string
  bumpedAt: string | null
  recallCount: number
  // Derived, not a stored column: true only while the ticket is queued as a
  // direct result of a recall (see kitchen/tickets.service.ts's toTicketView
  // for why status===queued && recallCount>0 is sufficient - a ticket can
  // only re-enter "queued" from "bumped" via recall).
  recalled: boolean
  lines: TicketLineView[]
}

export interface ExpoStationEntryView {
  stationId: string | null
  stationName: string | null
  ready: boolean
  tickets: TicketView[]
}

export interface ExpoOrderView {
  orderId: string
  tableLabel: string | null
  tokenNumber: number | null
  stations: ExpoStationEntryView[]
  waitingOn: TicketLineView[]
}

export interface AllDaySummaryEntryView {
  itemId: string
  itemName: string
  quantity: number
}
