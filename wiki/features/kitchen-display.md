# Kitchen Display (KDS) - backend (issue #67, CAP-1)

Backend for the kitchen ticket domain and fire hook. See
`restiq-design/docs/specs/spec-kitchen-display/SPEC.md` (CAP-1 is this
story; CAP-2..5's success criteria define what these reads must serve) and
`ARCHITECTURE-SPINE.md`'s AD-16. This is the keystone story for the four
KDS screen stories and two QR self-order stories - all consume the API
documented here verbatim.

## CAP-1 - Ticket domain, item-station routing, and fire-on-send

- **Intent:** sending an order to the kitchen (`open -> sent`) creates real
  tickets, one per station its lines route to, replacing the acknowledged
  status-flip-only stub. Re-firing after new lines appends an ADD-ON batch
  to the station's existing ticket; unrouted items still fire successfully.
- **Realm:** rides the existing `pos` realm unchanged (AD-16 - "auth realms
  separate principal types, not screens"). `src/platform/pos-auth.guard.ts`'s
  route match was extended from `^/pos(/|$)` to `^/(pos|kitchen)(/|$)` - the
  smaller of the two surgery options named in the story brief, versus
  mounting kitchen routes under `/pos/v1/kitchen`.

### Schema (migration `20260829060002_kitchen_ticket_domain_and_menu_routing`)

- `MenuItem.stationId` (nullable UUID, FK `Station`, `ON DELETE SET NULL`) -
  additive routing column on the already-shipped menu schema. One schema
  owner: only Tenant Admin's menu editor writes it
  (`PATCH /admin/v1/menu/items/:itemId/station { stationId? }`, also settable
  at create time via `CreateItemDto.stationId`). Null = unrouted.
- `Ticket` (`tickets`): `id, tenantId, outletId, orderId, stationId?,
  status (queued|bumped), recallCount, firedAt, bumpedAt?, recalledAt?`.
  One row per `(order, resolved station)` - never one row per fire event.
  `stationId: null` is the synthetic "unrouted" grouping (only possible when
  the outlet had zero stations at fire time).
- `TicketLine` (`ticket_lines`): `id, tenantId, ticketId, orderLineId,
  quantity, addOnBatch (int, default 0), voided (bool, default false),
  createdAt`. Unique on `(ticketId, orderLineId)` - an OrderLine is ticketed
  at most once. `addOnBatch` groups lines fired together: `0` is the order's
  original fire, `1+` is the Nth batch appended afterwards - the UI renders
  batch `>0` as a separated ADD-ON section. `voided` marks a struck-through
  fired line without deleting the row; **no current caller sets it** - see
  Key decisions.
- `TicketEvent` (`ticket_events`): `id, tenantId, ticketId, type
  (bumped|recalled|refired|add_on_fired), occurredAt`. Append-only - this is
  what "recall history" (CAP-4) actually reads from; `Ticket.recallCount`/
  `recalledAt` are a fast-read cache of the same facts.
- RLS: `tenant_isolation` + `operator_read` on all three new tables, same
  policy shape as every other tenant-owned table (copied from
  `floor_plan_stations`'s migration).

### Fire hook

- `src/kitchen/tickets.service.ts`'s `KitchenTicketsService.fireOnSend(tx,
  order)` - called from `src/pos/orders/orders.service.ts`'s `updateStatus`,
  inside the same transaction as the `open -> sent` status write. Loads
  every `OrderLine` on the order (all of them are unfired at this point),
  groups by resolved station, creates one `Ticket` per group with
  `TicketLine`s at `addOnBatch: 0`.
- `KitchenTicketsService.fireAddedLine(tx, order, line)` - called from
  `src/pos/order-lines/order-lines.service.ts`'s `addLine`, inside the same
  transaction, whenever a line is added to an order whose status is already
  `"sent"` (pos/CAP-3 allows this - `assertOrderNotClosed`, not
  `assertOrderOpenForEdit`, gates `addLine`). Resolves the line's station;
  if a `queued` ticket already exists there for this order, appends the new
  line as the next `addOnBatch`; otherwise (no ticket yet at that station,
  or the prior one there was already `bumped`) opens a **new** ticket at
  `addOnBatch: 0` - never a second ticket alongside a still-queued one.
- Routing default (documented choice): the outlet's oldest non-deleted
  `Station` (`orderBy: createdAt asc`). Zero stations at the outlet -> ticket
  fires with `stationId: null` (the "unrouted" grouping) rather than
  failing the order.

### Endpoints (`/kitchen/v1`, pos-realm `CurrentStaff`)

- `GET /kitchen/v1/outlets/:outletId/stations` -> `StationView[]`
  (`{ id, name, ageingThresholdMinutes }`) - the picker list.
- `GET /kitchen/v1/outlets/:outletId/stations/:stationId/queue` ->
  `TicketView[]`, queued tickets oldest-first (`firedAt asc`). `:stationId`
  accepts a real station id **or the literal string `"unrouted"`** to read
  the synthetic no-station grouping.
- `GET /kitchen/v1/outlets/:outletId/expo` -> `ExpoOrderView[]` - every
  order with status `"sent"` that has at least one ticket, tickets
  re-consolidated per station with a `ready` flag (`every ticket at that
  station is bumped`) and a `waitingOn` panel (lines from every
  still-queued ticket, voided lines excluded).
- `GET /kitchen/v1/outlets/:outletId/bumped` -> `BumpedTicketView[]`
  (`TicketView & { recallHistory: string[] }`), most-recently-bumped first.
- `GET /kitchen/v1/outlets/:outletId/all-day-summary` ->
  `AllDaySummaryEntryView[]` (`{ itemId, itemName, quantity }`) - summed
  only from real `queued`, non-voided `TicketLine`s.
- `POST /kitchen/v1/tickets/:ticketId/bump` -> `TicketView`. `409 conflict`
  if already bumped.
- `POST /kitchen/v1/tickets/:ticketId/recall` -> `TicketView`
  (`recalled: true`, `recallCount` incremented). `409 conflict` if the
  ticket isn't currently bumped.
- `POST /kitchen/v1/tickets/:ticketId/refire` -> `TicketView`. See Key
  decisions for what "refire" means here.
- No request bodies on the three action endpoints and no actor attribution
  anywhere in this API (approved decision, SPEC open question resolved
  "no" - shared station screen, FR-34).

`TicketView`: `{ id, orderId, stationId, stationName, tableLabel,
tokenNumber, status, firedAt, bumpedAt, recallCount, recalled, lines[] }`.
`TicketLineView`: `{ id, orderLineId, itemId, itemName, variantName,
quantity, seatNumber, modifiers[{id,name}], addOnBatch, voided }`. Exact
shapes: `src/kitchen/tickets.dtos.ts`.

## Integration points for later stories

- Stories 2-5 (K1-K4 screens) consume the reads above directly - no new
  backend reads should be needed; if one screen needs a projection this API
  doesn't already serve, extend `src/kitchen`, don't compose client-side
  from multiple calls (per stories.yaml's own guidance).
- qr-self-order/CAP-6 (status tracking) should read ticket bump state via
  this same module (`KitchenTicketsService`, exported from `src/kitchen`'s
  barrel) rather than re-deriving it - a guest's "your food is on the way"
  status is exactly a subset of `TicketView`.
- A future void-after-fire story (the `void_after_fire`
  `MANAGER_GATED_ACTIONS` entry in `platform/manager-auth.service.ts` is
  defined but has no caller yet) should set `TicketLine.voided` from inside
  its own manager-authorised transaction - the column and the "struck
  through, not deleted" contract already exist for it to write to.

## Key decisions

- **Default/unrouted station = the outlet's oldest station**, not a
  designated-by-name "expo" station - there is no station "role" or name
  convention in the schema to key off, and picking the earliest-created one
  is deterministic without adding one. Zero stations at the outlet -> the
  ticket still fires, grouped under the synthetic `stationId: null`
  "unrouted" bucket (addressed over HTTP by the literal path segment
  `unrouted`, since there's no real `Station` row to address it by).
- **"Voiding a fired line" has no real caller yet.**
  `order-lines.service.ts`'s `removeLine`/`updateLine` both call
  `assertOrderOpenForEdit`, which rejects any mutation once the order is
  `"sent"` - so nothing in the shipped POS surface can ever void a line
  post-fire today. `TicketLine.voided` and the "struck-through, not
  deleted" contract exist per SPEC/AD-16's data-model requirement anyway,
  ready for the (currently unwired) `void_after_fire` manager-gated action
  to write to.
- **`refire` is a documented design call**, since neither the SPEC nor
  stories.yaml define its semantics beyond naming it alongside bump/recall.
  Implemented as a force-resend: moves a ticket back to `queued` (a no-op
  if already queued) without touching `recallCount`/`recalledAt` and
  without resetting `firedAt` (the ageing clock keeps running) - distinct
  from `recall`, which is conditioned on the ticket being `bumped` and
  does mark the RECALLED/recall-history state.
- **Add-on batching is per `addLine` call, not per UI "send" action** -
  there is no batch-add or explicit "resend this order" endpoint in the
  real POS surface (`AddOrderLineDto` adds exactly one line per request), so
  each individual `addLine` against a `"sent"` order is its own `addOnBatch`
  on the target ticket.
- **Expo shows every `"sent"` order with a ticket, until the order closes**
  - not just orders with an unbumped ticket - so a fully-bumped order still
    reads as "ready to leave together" rather than vanishing from the
    screen the instant the last station bumps.
