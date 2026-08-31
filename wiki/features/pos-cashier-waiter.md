# POS Cashier & Waiter (Web Prototype) - backend

Backend for the `/pos` realm (AD-13): an online-only restiq-web prototype
standing in for the real native Android POS build. See
`restiq-design/docs/specs/spec-pos-cashier-waiter/SPEC.md` for the full
capability set (CAP-1..11); this doc tracks what's actually built here,
story by story.

## CAP-1 - PIN login and shift clock

- **Intent:** staff authenticate at a shared device with a 4-digit PIN and
  clock in/out; 5 wrong attempts locks that PIN for 30 seconds, and a
  successful PIN starts a `pos`-realm session and records a clock-in if none
  is open for that staff member today.
- **Built:** new fourth disjoint auth realm `pos` (AD-13), same pattern as
  ops/admin (AD-3/AD-10): `aud:"pos"`, own secret `POS_JWT_SECRET`,
  principal `{ id: staffId, tenantId, outletId }`. `src/platform/pos-jwt.ts`
  (sign/verify, never throws - `verifyPosToken` returns `null`),
  `src/platform/pos-auth.guard.ts` (`PosAuthGuard`, `CurrentStaff`
  decorator), registered as a third global `APP_GUARD` in
  `platform.module.ts` alongside `OpsAuthGuard`/`AdminAuthGuard`, gating
  `/pos(/|$)`. This is the story that actually stands up the `/pos` HTTP
  surface (`src/pos/`), which CAP-8 below still has no caller for.
- `POST /pos/v1/auth/login` `{ tenantId, pin }` - verifies the PIN against
  this tenant's active `StaffUser` rows (reusing `pinStatus()` from
  `admin/staff/staff.service.ts` verbatim, exported through the admin
  barrel for this). A single-outlet tenant finalises immediately (signs a
  pos token, records the clock-in). A tenant with more than one outlet
  instead gets `{ status: "select_outlet", pendingToken, outlets }` -
  `pendingToken` is a short-lived (5 min), *different-audience*
  (`aud:"pos-pending"`) token signed with the same `POS_JWT_SECRET`, so it
  can never satisfy the real `/pos` guard.
- `POST /pos/v1/auth/select-outlet` `{ pendingToken, outletId }` - verifies
  the pending token, checks the outlet belongs to that tenant, and
  finalises the same way (`src/pos/auth/auth.service.ts`).
- Lockout: 5 wrong attempts for the exact `(tenantId, pin)` pair locks that
  pair for 30 seconds (`src/pos/auth/lockout.ts`, in-memory `Map` -
  documented single-instance-only tradeoff, acceptable for this prototype,
  no schema churn). Scoped to the guessed PIN, not the tenant or a staff
  row, since a failed brute-force guess can't be attributed to one staff
  member until it succeeds. Returns `429 locked_out`.
- New `ClockEvent` model (`clock_in`/`clock_out`), RLS-protected the same
  way as every other tenant-owned table (`tenant_isolation` +
  `operator_read` policies, migration
  `20260825035228_pos_auth_clock`). Clock-in-once-per-local-day is enforced
  by reading the staff member's latest event and comparing calendar dates
  in the outlet's own timezone (`Outlet.timezone`, not UTC or the server
  clock) - `src/pos/clock/clock.util.ts#recordClockInIfNeeded`, called from
  inside the login/select-outlet transaction.
- `POST /pos/v1/clock/out` (guarded - needs a real pos session) - ends the
  day's open clock-in; `409 not_clocked_in` if the staff member's latest
  event isn't already an open clock-in (`src/pos/clock/clock.service.ts`).

### CAP-1 integration points for later stories

- CAP-11 (device & staff attendance status, story 11, since built - see
  its own section below) reads `ClockEvent` rows directly for "who's
  clocked in today" - no new mutation needed, this story's rows are the
  real data source.
- CAP-2..CAP-10's `pos/*` modules should depend on `CurrentStaff`/
  `PosPrincipal` from the platform barrel exactly like this story's own
  controllers do, and reuse this story's `PosAuthGuard` (already global) -
  never re-verify a pos token themselves.
- `platform/manager-auth` (CAP-8 below) is a distinct concern - it
  authorises manager-gated *actions* with a manager's own PIN, not staff
  login. Do not conflate it with this story's staff PIN login.

## CAP-2 - Table map and order ownership/transfer

- **Intent:** staff sees live per-table status (empty/occupied/needs-bill)
  and opens or claims a table's order; a second device can never silently
  edit an order already owned by another staff member - it must go through
  an explicit transfer action naming the new owner.
- **Built** (`src/pos/orders/`, wired via `src/pos/pos.module.ts`,
  `src/pos/index.ts`):
  - `GET /pos/v1/outlets/:outletId/table-map` - every table in the outlet
    with `status: 'empty' | 'occupied'`, plus `orderId`/`ownerId` when
    occupied. Reuses the existing `Floor`/`DiningTable` models from
    tenant-admin/CAP-5's floor-plan module directly (no second table model)
    - a table is "occupied" iff it has a non-`closed` `Order`.
  - `POST /pos/v1/outlets/:outletId/tables/:tableId/order` - opens a new
    `Order` on an empty table (owned by the caller) or returns the table's
    existing order unchanged if one is already open/sent. Viewing an
    occupied table is never a takeover. Always `200` - see the controller
    comment for why this endpoint doesn't distinguish 200-existing from
    201-created.
  - `GET /pos/v1/orders/:orderId` - any staff member may view any order in
    their tenant; viewing never requires ownership.
  - `PATCH /pos/v1/orders/:orderId/status` - owner-only. `open -> sent ->
    closed`, forward-only. A non-owner gets `403 not_owner` naming the
    current owner (`message` + `ownerId`) - never a silent edit.
  - `POST /pos/v1/orders/:orderId/transfer` - `{ newOwnerStaffId, reason? }`,
    callable by **anyone** (not CAP-8-gated - a normal handoff, not one of
    the six manager-authorised actions). Reassigns `ownerId` and writes an
    `audit_events` row (`order.ownership_transferred`) with a fixed
    placeholder reason when the caller omits one, since `audit_events.reason`
    is `NOT NULL`. The old owner cannot mutate the order once this completes.

### Data model

```prisma
model Order {
  id        String      @id @default(uuid(7)) @db.Uuid
  tenantId  String      @map("tenant_id") @db.Uuid
  outletId  String      @map("outlet_id") @db.Uuid
  tableId   String?     @map("table_id") @db.Uuid   // null = counter order (later story)
  ownerId   String      @map("owner_id") @db.Uuid   // -> StaffUser, reassigned only via transfer
  status    OrderStatus @default(open)              // open | sent | closed
  createdAt DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime    @updatedAt @map("updated_at") @db.Timestamptz(6)
}
```

- Migration `20260825100000_pos_order_ownership` (`prisma/migrations/`).
  Standard AD-5 tenant-isolation RLS policy, plus a hand-written partial
  unique index `orders_one_active_per_table` on `(table_id) WHERE table_id
  IS NOT NULL AND status <> 'closed'` - at most one live order per table,
  since the table map's occupied/empty status derives directly from this.
  Prisma's schema language has no partial-index syntax, so this one line is
  hand-added to the `prisma migrate diff` output rather than generated.
- **`tableId` is nullable today and unused as null** - reserved for a later
  counter-order (pos/CAP-6 QSR) story that opens an `Order` with no table.
  This story only ever sets it.
- **AD-14 does not bind this story.** AD-14's insert-only-past-finalisation
  discipline binds pos/CAP-6, 7, 9, 10 - not CAP-2. At this base-fields stage
  (no `OrderLine`, no `Bill` yet) an `Order` is an ordinary mutable draft
  row: status moves forward by plain `UPDATE`, gated by ownership, not by a
  finalise/insert-only discipline. A later story (CAP-7, bill & settle) is
  what actually makes closing an order mean something real.
- **`needs-bill` is a documented TODO, not built.** SPEC's third table-map
  state depends on whether a `Bill` has been requested for the table's
  order - `Bill` doesn't exist yet (a later story introduces it per AD-14).
  See the `TODO(pos/CAP-7 ...)` comment on `TableMapEntry` in
  `src/pos/orders/orders.dtos.ts`.

### The pos auth realm - reconciled with pos/CAP-1 (issue #44)

This story was built before pos/CAP-1's real PIN login (issue #44) merged,
so it originally shipped its own stub of `src/platform/pos-jwt.ts`/
`pos-auth.guard.ts` with a "reconcile once #44 merges" note. That
reconciliation is now done: CAP-1's `signPosToken`/`verifyPosToken`/
`PosAuthGuard`/`CurrentStaff` (`aud: "pos"`, `POS_JWT_SECRET`) are the one
real implementation this story's `pos/orders/` module calls into - no
second signing/verification logic remains. The one merge-time addition CAP-1
didn't originally need: `PosPrincipal` carries `name` (not just `id`/
`tenantId`/`outletId`) because `orders.service.ts`'s ownership-transfer
audit row uses `staff.name` as `actorEmail` directly from the token, without
a second `StaffUser` lookup - `auth.service.ts`'s `finalize()` sets it from
the same `StaffUser` row it already has in hand.

### Test coverage (`test/pos-orders.e2e-spec.ts`, 11 tests, e2e against a
real Postgres test DB)

- Table map shows empty before any order, occupied once one opens (with the
  right `orderId`/`ownerId`), and empty again once the order closes.
- An invalid forward transition (`open` straight to `closed`) is rejected
  `409 invalid_transition`.
- Claiming an already-occupied table returns the *same* order, never a
  second one (also checked directly against the `orders` table row count).
- Any staff member can view an occupied table's order.
- A non-owner's mutation is rejected `403 not_owner`, naming the current
  owner (id and name in the message).
- Transfer reassigns ownership; the new owner can then mutate, the old
  owner is rejected afterward, and an `audit_events` row is written.
- Transferring to a staff member from another tenant is rejected `400`.
- No session -> `401`; another tenant's table map/order -> `404` (never a
  different shape leaking existence).

### CAP-2 integration points for later stories

- pos/CAP-3 (order taking) and pos/CAP-4 (group ordering) extend this
  `Order` with `OrderLine` - the base shape (`id`, `tenantId`, `outletId`,
  `tableId`, `ownerId`, `status`, timestamps) is meant to be extended, not
  replaced. Read the exact field names above before adding `OrderLine`.
- pos/CAP-5 (open/held orders, issue #53, since built - see its own section
  above) lists exactly the rows this story already writes, via a
  tenant/outlet-scoped `findMany` added directly to this story's
  `OrdersService`, and reuses `transfer()` unchanged for take-over.
- pos/CAP-6 (QSR counter) is the first caller that creates an `Order` with
  `tableId: null`.
- pos/CAP-7 (bill & settle) is what finally makes `status: 'closed'` mean
  something (today it's just a terminal status with no side effects) and is
  what the table map's `needs-bill` TODO depends on.
- pos/CAP-1 (PIN login, issue #44, since merged) is what this story's
  `/pos` auth realm now defers to - see "The pos auth realm" above.

### CAP-2 key decisions

- Table map reads `Floor`/`DiningTable` directly via Prisma inside
  `OrdersService`, rather than importing tenant-admin's `FloorPlanService`:
  that service's methods take an `AdminPrincipal`, not a `PosPrincipal`, and
  the read here is a plain tenant/outlet-scoped `findMany` - reusing the
  *models* (as the story requires) doesn't require reusing that service's
  owner-shaped API.
- `openOrClaimTable` is check-then-create inside one transaction, with the
  `orders_one_active_per_table` unique index as a race backstop (caught via
  `isUniqueViolation`, same one-line convention as `admin/menu/menu-errors.ts`
  and others) - a concurrent double-open on the same table re-reads and
  returns the winner's order instead of surfacing a raw DB error.
- Transfer's `reason` is optional per stories.yaml story 3 ("not one of
  CAP-8's six gated actions") but `audit_events.reason` is `NOT NULL` - a
  fixed placeholder string covers the no-reason case rather than making the
  column nullable for one caller.

## CAP-3 - Order taking with modifiers, variants, combos

- **Intent:** staff builds an order via grid/category/search, configuring
  modifier groups per item; a line violating a modifier group's min/max
  cannot be added, and every line records which staff member added it.
- **Built** (`src/pos/orders/order-lines.service.ts`, wired into the same
  controller/module as CAP-2's `src/pos/orders/orders.controller.ts` -
  extends the existing module, no parallel one):
  - `POST /pos/v1/orders/:orderId/lines` -> `{ itemId, variantId?, quantity,
    modifierIds? }` (201). Owner-only. Validates `itemId`/`variantId`/every
    `modifierIds` entry against the real menu catalogue (tenant-admin/CAP-4's
    `MenuItem`/`ItemVariant`/`ModifierGroup`/`Modifier` - read directly, no
    duplicated shape), resolves the item's *current* price via
    `admin/menu/pricing.ts#resolveCurrentPrice` (reused verbatim through the
    admin barrel, channel fixed to `'dine_in'` - see "Key decisions"), and
    snapshots it into `unitPriceMinor`/`OrderLineModifier.priceMinor` at
    add-time. Returns the full `OrderView` (base fields + `lines[]`), not just
    the created line - same "mutate a sub-resource, return the whole parent
    view" convention as `admin/menu/items.service.ts#addVariant`.
  - `PATCH /pos/v1/orders/:orderId/lines/:lineId` -> `{ quantity?,
    modifierIds? }` (200). Owner-only, **only while the order is still
    `open`**. Omitting `modifierIds` leaves selections untouched; passing it
    (even `[]`) replaces the line's modifiers wholesale, re-validated exactly
    like on add (a fresh price snapshot for whatever's newly selected).
  - `DELETE /pos/v1/orders/:orderId/lines/:lineId` -> (200, full `OrderView`).
    Owner-only, **only while the order is still `open`**.
  - `GET /pos/v1/orders/:orderId` (CAP-2's existing endpoint) now returns
    `lines[]` too - `OrdersService`'s `buildOrderView()` replaced the old
    `toOrderView()` everywhere (table-map claim/open, status update, transfer,
    get, and CAP-5's `listOpenOrders()`) so every order read/mutation
    response carries the same shape.
- **Modifier-group validation is against every group attached to the item,
  not just the groups a submitted `modifierId` happens to touch.** A required
  group (`minSelections > 0`) with nothing selected is rejected exactly like
  over-selecting an optional one - `400 modifier_selection_invalid` naming
  the group and the required range. A `modifierId` that doesn't belong to any
  of the item's attached groups is rejected `400 validation_failed`. This
  runs server-side unconditionally - a client that skips its own validation
  gets the same rejection (`src/pos/orders/order-lines.service.ts#assertModifierSelectionValid`).
- **Add vs. edit/remove have different mutability windows, on purpose:** a
  line can be **added** any time the order isn't `closed` (kitchen can still
  receive more items on an already-`sent` order - AD-14: "Order is mutable
  pre-finalisation"), but can only be **edited or removed** while the order
  is still `open` - once `sent`, the kitchen may already be acting on that
  specific line, so it's frozen except for outright new additions. See
  stories.yaml story 4's own PATCH/DELETE wording ("before the order is
  sent" / "only while order is still open") for where this split comes from.
- **Ownership is reused, not reimplemented.** `loadOrder`/`assertOwner` were
  pulled out of `OrdersService` into exported top-level functions in
  `orders.service.ts`; `order-lines.service.ts` imports and calls them
  directly. A non-owner gets the exact same `403 not_owner` (message +
  `ownerId`) as CAP-2's own status/transfer endpoints.

### Data model

```prisma
model OrderLine {
  id             String   @id @default(uuid(7)) @db.Uuid
  tenantId       String   @map("tenant_id") @db.Uuid
  orderId        String   @map("order_id") @db.Uuid
  itemId         String   @map("item_id") @db.Uuid
  variantId      String?  @map("variant_id") @db.Uuid
  quantity       Int
  unitPriceMinor BigInt   @map("unit_price_minor")   // snapshotted at add-time
  seatNumber     Int?     @map("seat_number")         // pos/CAP-4 (issue #58) - see below
  addedByStaffId String   @map("added_by_staff_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
}

model OrderLineModifier {
  id          String @id @default(uuid(7)) @db.Uuid
  tenantId    String @map("tenant_id") @db.Uuid
  orderLineId String @map("order_line_id") @db.Uuid   // ON DELETE CASCADE from OrderLine
  modifierId  String @map("modifier_id") @db.Uuid
  priceMinor  BigInt @map("price_minor")              // snapshotted at add-time
}
```

- Migration `20260825200000_pos_order_lines_modifiers`. Standard AD-5
  `tenant_isolation` + `operator_read` RLS on both new tables, same posture
  as every other tenant-owned table. `order_line_modifiers.order_line_id` is
  the only `ON DELETE CASCADE` FK in this pair (deleting an `OrderLine` via
  the DELETE endpoint cleans up its modifier-selection rows automatically);
  every other FK here (`order_id`, `item_id`, `variant_id`, `added_by_staff_id`,
  `modifier_id`) is `RESTRICT`/`SET NULL` per the existing schema-wide
  convention (see `orders`/`item_variants` for the same pattern).
- `itemId`/`variantId`/`addedByStaffId` point straight at
  `MenuItem`/`ItemVariant`/`StaffUser` - no duplicated snapshot of the item's
  name/etc. on the line itself (a display layer joins for that; only the
  *price* is a snapshot, per the story's explicit requirement).
- Money is `bigint` minor units on both tables (workspace convention); the
  `OrderLineView`/`OrderLineModifierView` DTOs convert to plain JS `number`
  at the API boundary, same pattern as `item_prices.priceMinor` elsewhere.

### Test coverage (`test/pos-order-lines.e2e-spec.ts`, 26 tests including
pos/CAP-4's below, e2e against a real Postgres test DB)

- A valid line is added and appears on the order (and on a subsequent `GET`);
  a variant-specific price resolves correctly when `variantId` is given.
- A valid modifier selection is added with each modifier's price snapshotted
  per-selection.
- A line violating a modifier group's min/max is rejected `400
  modifier_selection_invalid` - both under-selecting a required group (empty
  selection) and over-selecting an optional one - even when the request sends
  no client-side-valid selection at all.
- A `modifierId` that doesn't belong to the item, an item with no configured
  price, and an item from another tenant are each rejected `400`.
- Adding a line still succeeds once the order has been `sent` (proving the
  add/edit mutability asymmetry above); adding to a `closed` order is
  rejected `409`.
- A non-owner is rejected `403 not_owner` on add, edit, and remove.
- Changing quantity via `PATCH` works while `open`; re-selecting modifiers via
  `PATCH` re-runs the same min/max validation as add.
- Editing or removing a line once the order is `sent` is rejected `409` on
  both endpoints; the line is left untouched in the DB (row-count checked
  directly, not just the HTTP status).
- **Price snapshotting proof:** a line is added, the item's price is then
  changed via a fresh `ItemPrice` insert, and the *existing* line's
  `unitPriceMinor` on a subsequent `GET` is unchanged - while a *new* line
  added afterward picks up the new price, proving the first line's value is
  a frozen snapshot and not a live join.
- Removing a line id that doesn't belong to the given order 404s.

### CAP-3 integration points for later stories

- pos/CAP-4 (group ordering, story 5, issue #58) has since landed - see the
  dedicated section below. It extended this exact `OrderLine` with
  `seatNumber`, no field renamed.
- pos/CAP-6 (QSR counter) and pos/CAP-7 (bill & settle) compose over these
  same endpoints/rows rather than a parallel line-item implementation. CAP-7
  is what will need to sum `OrderLine.unitPriceMinor * quantity +
  OrderLineModifier.priceMinor` per line for a Bill's total - no such
  aggregation exists yet in this codebase.
- `ORDER_PRICE_CHANNEL` in `order-lines.service.ts` is hardcoded to
  `'dine_in'` because `Order` has no channel column and this story only ever
  builds dine-in table orders (opened via CAP-2's table map). If/when
  pos/CAP-6 needs a different channel for counter orders, that's a new
  decision for that story to make, not a change forced on this one.

### CAP-3 key decisions

- Combos (mentioned in the capability title) are **not** built as an
  order-line type in this story - stories.yaml story 4's actual endpoint
  contract and the SPEC's screens (P3/P4) only describe item/variant/modifier
  lines, and the UX companion docs have no combo-ordering screen either.
  `OrderLine.itemId` points at `MenuItem` only; a combo line is left for
  whichever future story actually needs it (ponytail: don't build what
  wasn't asked for).
- `resolveCurrentPrice` is imported from `admin/menu/pricing.ts` through the
  `admin` barrel (`src/admin/index.ts`) rather than reimplemented - the exact
  same channel/outlet/variant specificity and future-dated-row rules
  tenant-admin/CAP-4 already established are what a POS add-line has to
  respect; a second price-picker would be a second place for that logic to
  drift.
- No price is resolved for a *modifier* through `resolveCurrentPrice` -
  `Modifier.priceMinor` is a flat, non-versioned column by schema design (see
  `prisma/schema.prisma`'s comment on `Modifier`), so its current value is
  read directly and snapshotted into `OrderLineModifier.priceMinor`.

## CAP-4 - Group ordering (seats and covers)

- **Intent:** staff can split one table's order into named seats/covers for
  later per-seat billing. **Success:** every item is assigned to a seat
  number before the order can be sent to the kitchen; unassigned items block
  fire.
- **Built** (issue #58, story 5): extends pos/CAP-3's exact `OrderLine`
  (`src/pos/orders/order-lines.service.ts`, `orders.dtos.ts`) and pos/CAP-2's
  order status transition (`src/pos/orders/orders.service.ts#updateStatus`)
  in place - no new endpoint, no new module.
  - `POST /pos/v1/orders/:orderId/lines` and
    `PATCH /pos/v1/orders/:orderId/lines/:lineId` both gained an optional
    `seatNumber` (`number`, `>= 1`) field, additive to CAP-3's DTOs. Add
    defaults it to `null` when omitted; PATCH leaves it untouched when
    omitted, same "omit = leave alone" convention CAP-3 already established
    for `modifierIds`. Every `OrderLineView` now carries `seatNumber: number
    | null`.
  - `PATCH /pos/v1/orders/:orderId/status` with `{ status: 'sent' }` now
    rejects `400 unseated_lines` (naming the count, `/seat/i`-matchable
    message) if **any** line on the order has `seatNumber: null` - checked in
    `orders.service.ts#assertAllLinesSeated` only on the `open -> sent`
    transition, inside the same `$transaction` as the rest of `updateStatus`.
    The order's `status` is left `open` when this fires (the `tx.order.update`
    never runs).
  - Orders that never use group ordering are completely unaffected: a table
    order with zero lines, or every line still carrying `seatNumber: null`
    only fails to `send` if the tenant actually has an unseated line at that
    moment - a table with **no lines at all** sends exactly as it did before
    this story (existing pos/CAP-2/CAP-3 tests exercise this, unchanged).
- **Application-enforced, not a DB constraint.** `seat_number` is nullable at
  the Postgres level (migration safety on an already-populated table); the
  "every line must be seated before send" rule lives entirely in
  `orders.service.ts`, the sole enforcer of `Order.status`, same posture the
  file already documents for the status column itself.

### Data model

Adds one column to the table CAP-3 already owns - see the updated
`OrderLine.seatNumber` line in CAP-3's Data model block above; nothing else
changes.

- Migration `20260825300000_pos_order_line_seat_number`:
  `ALTER TABLE "order_lines" ADD COLUMN "seat_number" INTEGER;` - no RLS
  changes needed (existing `order_lines` policies already cover every column).

### Test coverage (`test/pos-order-lines.e2e-spec.ts`, `describe('seat
numbers (group ordering)')`, 6 of the file's 26 tests)

- A line added with `seatNumber` carries it on the returned `OrderView`; a
  line added without one carries `seatNumber: null` (CAP-3 behaviour
  unchanged for tenants not using group ordering).
- `PATCH .../lines/:lineId` can assign a seat number to an existing line.
- An order with every line seated sends successfully (`status` becomes
  `'sent'`).
- An order with any unseated line (including a mix of seated and unseated, or
  all-unseated) is rejected `400 unseated_lines` with a message matching
  `/seat/i`, and a follow-up `GET` confirms the order is still `'open'`.
- `test/pos-order-lines.e2e-spec.ts`'s two pre-existing "once the order has
  been sent" tests (editing/removing a sent-order line) now seat their line
  before sending - they exist to prove CAP-3's send-freezes-lines rule, not
  this gate, so they satisfy the new gate rather than exercising it.

### CAP-4 integration points for later stories

- **Update (pos/CAP-7, issue #59, landed after this note was written):**
  `POST /pos/v1/bills/:id/finalize` does **not**, in the end, read
  `OrderLine.seatNumber` for anything - see CAP-7's own "Split types" note
  below. Group ordering's data entry and send-time gate stand as originally
  built; no seat/cover grouping or totals aggregation exists anywhere in
  this codebase yet, and CAP-7 deliberately doesn't add one.
- `OrderLineView.seatNumber` is `number | null` at the API boundary, same
  as every other optional line field - a client renders "no seat" for `null`
  rather than treating it as `0` or omitted.

## CAP-5 - Open and held orders (outlet-wide)

- **Intent:** staff sees every open/held order outlet-wide and resumes their
  own or takes over someone else's; taking over requires the same
  explicit-transfer action as CAP-2, never a silent switch.
- **Built** (`src/pos/orders/`, extending story 3/CAP-2's existing
  `OrdersService`/`PosOrdersController` - no new module):
  - `GET /pos/v1/outlets/:outletId/orders` - every non-`closed` `Order` in
    the outlet, table-tied or counter (`tableId: null`) alike. This is the
    outlet-wide complement to CAP-2's `GET .../table-map`, which only shows
    orders attached to a table and would never surface a future CAP-6
    counter order. Any staff member may view the list - viewing never
    requires ownership, same posture as `GET /orders/:orderId`.
  - Take-over is **not** a new mechanism: a client takes over an order in
    this list by calling CAP-2's real `POST /pos/v1/orders/:orderId/transfer`
    directly. This story adds zero lines to `transfer()`/`updateStatus()`.
- **No OrderLine summary at the time this story was built - since resolved
  by CAP-3 (issue #52), not by this story.** `OrderLine` didn't exist in the
  schema when this story shipped, so it originally returned plain
  `OrderView` with a TODO to fold in a summary once it did. CAP-3 has since
  landed and its `buildOrderView()` now backs every order read/mutation
  response, including this list - `listOpenOrders()` was updated to call it
  (one line: `orders.map(toOrderView)` became
  `Promise.all(orders.map((order) => buildOrderView(tx, order)))`) so each
  entry carries its real `lines[]` (full detail, not a separate
  item-count/running-total projection; SPEC.md never required a summary
  distinct from the real lines).
- **Ordering:** `orderBy: { createdAt: 'asc' }` - oldest-open-first, so an
  order that's been sitting longest surfaces first; same tie-break
  simplicity as CAP-2's table-map query.

### Test coverage (`test/pos-open-held-orders.e2e-spec.ts`, 6 tests, e2e
against a real Postgres test DB)

- Lists every open/sent order outlet-wide, including a counter order
  (`tableId: null`) that CAP-2's table-map would never show.
- Excludes closed orders.
- A take-over via CAP-2's real `POST /orders/:orderId/transfer` is reflected
  on the next read of this list (proves reuse, not a second ownership path).
- Any staff member can view the list, not only the order's owner.
- No session -> `401`; another tenant's outlet -> `404`.

## CAP-6 - QSR counter and token mode

- **Intent:** for counter-service outlets, one staff member rings up items
  and takes payment in a single flow, issuing a queue token instead of
  assigning a table. **Success:** completing a counter order issues a
  sequential token number and finalises the bill in the same action - no
  separate waiter hop.
- **This is a composition story, not a parallel implementation** (per its
  own dispatch note). It does not add a new order type or reimplement
  order-line/bill logic: `Order.tableId: null` (a counter order) was already
  supported by CAP-2/CAP-3's real schema and `order-lines.service.ts`; the
  only genuine gap was that **no endpoint existed to create one** -
  `openOrClaimTable` (CAP-2) always requires a `tableId`. This story fills
  exactly that gap and adds token numbering; everything after creation
  reuses CAP-3's and CAP-7's real endpoints **unchanged**.
- **Built** (`src/pos/orders/orders.service.ts`/`orders.controller.ts`,
  extending the existing module - no new module):
  - `POST /pos/v1/outlets/:outletId/counter-orders` (201) -
    `OrdersService.createCounterOrder()`. In one transaction: validates the
    outlet, reserves the next token number, then creates an
    `Order { tableId: null, ownerId: <caller>, status: 'open', tokenNumber }`.
    Always creates a brand-new order (unlike `openOrClaimTable`'s
    get-or-open semantics) - a counter has no table identity to key an
    existing-order lookup on, so every call issues a new order and a new
    token. Empty body; no DTO.
  - `Order.tokenNumber: Int?` (new column, `orders.token_number`) - `null`
    on every table (dine-in) order, a real number only on a counter order.
    Returned on every `OrderView` (table map, list, get, and every mutation
    response) alongside the existing fields.
- **The rest of the flow is composition over already-merged endpoints,
  exactly as scoped - see "Call sequence for the web story" below.**
  `order-lines.service.ts`'s `addLine`/`updateLine`/`removeLine` and
  `bills.service.ts`'s `createBill`/`finalize` were not touched.
  `bills.service.ts`'s `createBill` already accepted an `'open'` order (not
  just `'sent'`) specifically anticipating this story (see CAP-7's own doc
  entry) - a counter order never needs to transition through `'sent'`
  (kitchen-fire) at all, which is exactly the "no separate waiter hop" the
  success criterion asks for. Sending it to the kitchen (`PATCH
  /orders/:orderId/status {status:'sent'}`) is optional and only needed if
  the outlet also wants a KOT print for the kitchen; CAP-4's
  every-line-must-be-seated gate only applies on that transition, so a pure
  ring-up-and-settle counter flow that skips it never has to assign seats
  either.
- **Call sequence for the web story** (one continuous client interaction,
  per SPEC.md's success signal - not necessarily one HTTP call):
  ```
  1. POST /pos/v1/outlets/:outletId/counter-orders      -> OrderView (tokenNumber assigned)
  2. POST /pos/v1/orders/:orderId/lines   (repeat per item, unchanged CAP-3)
     [optional] PATCH/DELETE .../lines/:lineId           while order stays 'open'
  3. POST /pos/v1/orders/:orderId/bill                   -> BillView (status 'open', unchanged CAP-7)
  4. POST /pos/v1/bills/:billId/finalize  { tenders: [...] } -> BillView (status 'finalized', unchanged CAP-7)
  ```
  Step 1 issues the token (shown to the customer/on the POS/KDS screen per
  SPEC's inherited assumption - no separate customer-facing token board);
  step 4 is the single action that both takes payment and closes the order.
  No step in between requires a second staff member or a table hand-off.
- **Token numbering (gapless, per outlet) - `TokenNumberCounter`, a new
  model, not a second column on `BillNumberCounter`.** Same reserve-then-
  commit discipline as CAP-7's `BillNumberCounter`: one row per outlet
  (`lastNumber`), incremented by a plain transactional `UPDATE`/`upsert`
  **inside** `createCounterOrder()`'s own transaction, only after the
  outlet-existence check has passed - a validation failure never touches
  the counter, and if the order-create itself somehow failed afterward, the
  whole transaction (counter increment included) rolls back with it, same
  as CAP-7's bill numbering. Not a Postgres `SEQUENCE`, for the identical
  reason CAP-7 gives: `nextval()` does not roll back with an aborted
  transaction. **A separate table from `BillNumberCounter`, not a second
  column on it**, because the two sequences are reserved at different
  moments by different services (token at order creation, bill number at
  bill finalise) - an outlet's counter-order count and bill count diverge
  from the very first order, and a shared row would need to distinguish
  "not yet touched" from "touched by the other sequence" for no benefit.
  `orders.token_number` is nullable with a plain (non-partial) unique index
  on `(tenant_id, outlet_id, token_number)` - Postgres already treats every
  `NULL` as distinct, so every table order coexists without a `WHERE`
  clause, identical posture to `bills.bill_number`.
- **Price channel left as-is, not changed by this story.** `order-lines.
  service.ts` hardcodes `ORDER_PRICE_CHANNEL = 'dine_in'` for every order
  regardless of `tableId`, with its own comment anticipating that "QSR/
  counter mode... picks its own channel when it exists; there is no channel
  column on Order today to read instead." Adding a real channel column and
  wiring counter orders to `PriceChannel.takeaway` would touch CAP-3's
  shared, already-merged endpoint and would need its own price-catalogue
  decision (does every item have a takeaway price configured?) - out of
  this story's scope per its "reuse story 4's endpoints unchanged" brief.
  Documented here as a known, deliberate gap for a future pricing story,
  not fixed silently.

### Test coverage (`test/pos-counter-orders.e2e-spec.ts`, 6 tests, e2e
against a real Postgres test DB)

- Creating a counter order returns a `tableId: null` order owned by the
  caller, with a real token number.
- Tokens number 1, 2, 3... gapless per outlet, and independently across
  outlets (a second outlet also starts at 1) - same convention proven for
  bill numbers in `test/pos-bills.e2e-spec.ts`.
- Token numbering survives a failed/aborted creation attempt without
  gapping: a request against a nonexistent outlet fails before the counter
  is ever touched (no `TokenNumberCounter` row created), and the next real
  creation still reserves token 1.
- An outlet belonging to a different tenant is rejected (404).
- A table (dine-in) order opened via CAP-2's `openOrClaimTable` never
  carries a token number.
- The full compose-order -> add-lines -> bill -> finalize sequence
  completes end to end against the real CAP-3/CAP-7 endpoints: token issued
  at creation, bill created directly against the still-`open` order (no
  `sent` transition), finalised with a single cash tender, order closes,
  and the token number issued at creation is preserved on the closed order
  (never overwritten by the unrelated bill number).

## CAP-7 - Bill and settle

- **Intent:** staff finalises an Order into a Bill with a tax breakdown, an
  optional discount carrying a reason code, an optional split (seat/item/
  N-way/amount/percent), and one or more tenders (cash or UPI-manual). A
  finalised Bill is immutable and carries a gapless per-outlet bill number;
  multi-tender totals must equal the Bill total before it can finalise.
- **Built** (new `src/pos/bills/`, greenfield `Bill`/`Tender`/
  `BillNumberCounter` models per AD-14 - the last pieces of that story's
  table list, alongside `Order`/`Shift`/`CashMovement`):
  - `POST /pos/v1/orders/:orderId/bill` (201) - snapshots the order's
    current lines into `subtotalMinor`/`taxMinor` on a new, still-`open`
    Bill. **Owner-only** (CAP-2's `assertOwner`, reused verbatim - not
    reimplemented). The order must be `open` or `sent`, not `closed`:
    `sent` is the normal dine-in path (already fired to the kitchen), but
    `open` is accepted too since the architecture's own capability map
    (`pos/CAP-6 QSR counter & token | pos/orders + pos/bills composition`)
    composes a future counter-service flow directly over this endpoint, and
    a counter order never needs a kitchen-fire step. Only one Bill may ever
    exist per order (`orderId` is unique on `Bill`) - a second create
    attempt is `409 bill_already_exists`, not merged into the first.
  - `POST /pos/v1/bills/:id/finalize` (200) - body
    `{ discountMinor?, discountReason?, managerPin?, tenders: [{ method,
    amountMinor }] }`. Validates the tender sum equals the bill total
    (`subtotal + tax - discount`), routes a discount above the threshold
    through `platform/manager-auth`, reserves the gapless bill number, and
    writes everything - Bill, Tenders, the manager-auth audit row, and the
    Order's `closed` status - in one transaction. **Not** owner-restricted
    (unlike create): a cashier settling at a register is frequently not the
    waiter who owns the order, and SPEC-CAP-7 names no ownership
    restriction for this step. `409 already_finalized` on any second
    finalise attempt (a `status='open'` compare-and-swap `UPDATE`, not a
    plain update-by-id, so a concurrent double-finalise race lands the same
    409 instead of corrupting the row).
  - `GET /pos/v1/bills/:id` - one bill by id, with its tenders, 404 across
    tenants.
- **Split types (seat/item/N-way/amount/percent):** implemented as
  "finalise against an arbitrary list of tenders." N-way and amount/percent
  splits are structurally just multiple `Tender` rows whose amounts sum to
  the bill total - however a client computed each tender's amount, this
  endpoint doesn't need to know. Per-seat/per-item splits are, per SPEC's
  own words, mostly a web-side UI concern of grouping lines before computing
  those tender amounts - so even though `OrderLine.seatNumber` now exists
  (pos/CAP-4 group ordering, issue #58, merged into `dev` while this story
  was in flight), `finalize()` deliberately does not read it or validate a
  split's tender amounts against seat assignment. Re-deriving a per-seat
  subtotal here would duplicate a grouping this module has no other use
  for; a future per-seat billing UI computes those amounts client-side from
  the order's own `lines[].seatNumber` (already returned by every order
  read) and just posts however many tenders that produces. Documented as a
  deliberate scope call, not an oversight - see the CAP-4 section's own
  updated integration-points note above.
- **Tax - no real rate field exists anywhere in the schema.** Checked
  `MenuItem`/`MenuCategory`/`ItemPrice` (admin/menu) and
  `Tenant`/`TenantTaxRegistration` (the latter carries a registration-type
  enum and a `taxProfile` string, not a rate) - none carry a tax rate.
  Per this story's brief, a flat **5% placeholder** is applied to
  `subtotalMinor` (`TAX_RATE_PLACEHOLDER_PERCENT` in `bills.service.ts`),
  clearly commented as a TODO rather than a real GST/VAT figure for any
  jurisdiction. **A future tax-configuration story owns making this a real,
  tenant-configurable rate** - not invented here.
- **Discount-above-threshold routes through the real `platform/manager-auth`
  service (AD-15)**, per stories.yaml's explicit instruction, rather than
  accepting a bare reason string: `ManagerAuthService.authorize
  ('discount_above_threshold', tenantId, outletId, managerPin,
  discountReason)` before the mutation, `.recordApproval()` inside the same
  finalise transaction - the exact call shape documented in this doc's own
  CAP-8 "How to call this" section above, followed as written, not guessed.
  `discountMinor`/`discountReason` must be given together or not at all
  (validated in the service; class-validator has no clean "both or
  neither" decorator for two independent optional fields).
  - **Threshold value:** SPEC.md's Assumptions/Open Questions leave the
    actual number undecided ("a sane default is assumed pending a real
    settings field"); this story's own `.memlog.md` names the example "any
    discount over 20%". `DISCOUNT_THRESHOLD_PERCENT = 20` (of the bill's
    `subtotalMinor`) is that default, documented as a TODO for a future
    tenant-settings story to make real and per-tenant configurable.
- **Gapless numbering (AD-14): reserve-then-commit via a counter row, not a
  Postgres `SEQUENCE`.** `BillNumberCounter` is one row per outlet
  (`lastNumber`), incremented by a plain `UPDATE`/`upsert` **inside** the
  same finalise transaction, only after every validation (order/bill state,
  discount/reason pairing, manager-auth, tender-sum match) has already
  passed. A `SEQUENCE`'s `nextval()` is deliberately not used here: it does
  not roll back with an aborted transaction, which is exactly the gap this
  story must not introduce. Because the counter is touched last and inside
  the same transaction as everything else, a validation failure never
  reserves a number, and if anything later still fails, the whole
  transaction (counter increment included) rolls back with it - either way,
  gapless. `bills.bill_number` is nullable (`null` until finalised) with a
  plain (non-partial) unique index on `(tenant_id, outlet_id, bill_number)`
  - Postgres already treats every `NULL` as distinct in a unique index, so
  any number of still-open bills coexist without needing a partial-index
  `WHERE` clause.
- **`ShiftsService.closeShift()`'s expected-amount formula, completed.**
  CAP-10's own doc entry below left a TODO here ("fold in real cash-tender
  bill totals... once Order/Bill/Tender land"): `expectedMinor` is now
  `floatMinor + sum(cash-tender bill totals since the shift opened) -
  paid_outs - bank_drops`, not just float minus paid-outs/bank-drops.
  `Tender` carries no `shiftId` column (by design - see the DTO/schema
  contract below); "cash tenders on bills finalised at this outlet since
  `shift.openedAt`" is unambiguous without one, since CAP-10 already
  enforces one open shift per outlet at a time. See
  `test/shift-cash-management.e2e-spec.ts`'s two new cases proving this
  (folds in real cash sales; never folds in a bill finalised before the
  shift opened or at a different outlet).
- **Schema/endpoint contract other stories depend on** (story 7/QSR counter,
  story 10/refunds - read this before building against it):
  ```
  Bill { id, tenantId, outletId, orderId (unique),
         billNumber: number | null,     // null until finalised
         subtotalMinor, taxMinor,
         discountMinor: number | null, discountReason: string | null,
         status: "open" | "finalized",
         createdByStaffId, createdAt,
         finalizedByStaffId: string | null, finalizedAt: string | null }
  Tender { id, tenantId, billId, method: "cash" | "upi_manual", amountMinor, createdAt }

  POST /pos/v1/orders/:orderId/bill          -> 201 BillView (empty body)
  GET  /pos/v1/bills/:id                     -> 200 BillView
  POST /pos/v1/bills/:id/finalize            -> 200 BillView
    body: { discountMinor?, discountReason?, managerPin?,
            tenders: [{ method: "cash"|"upi_manual", amountMinor }] }
  // BillView adds a derived `totalMinor` (subtotal + tax - discount) and
  // `tenders: TenderView[]` - never persisted as its own column.
  ```

### Test coverage (`test/pos-bills.e2e-spec.ts`, 12 tests, e2e against a
real Postgres test DB)

- Creating a bill from a real order's lines computes the correct
  subtotal and the 5% placeholder tax.
- A non-owner cannot create a bill (403, naming the current owner).
- A second bill cannot be created for the same order (409
  `bill_already_exists`).
- Finalising with a matching single tender succeeds, closes the order, and
  is immutable after - a second finalise attempt is `409 already_finalized`.
- A split multi-tender settlement summing to the total succeeds.
- A mismatched tender sum is rejected (400 `tender_mismatch`), and the bill
  stays `open`.
- A discount above the threshold with no manager PIN is rejected (400
  `manager_pin_required`); with a wrong PIN, `401`; the bill stays `open`
  either way.
- A discount above the threshold with a valid manager PIN succeeds and
  writes the real `audit_events` row via `platform/manager-auth`.
- A discount below the threshold needs no manager PIN at all.
- `discountMinor` without `discountReason` is rejected (400
  `validation_failed`).
- Bill numbers are gapless per outlet across multiple bills, **including
  after a rejected/failed finalise attempt** (a failed finalise never
  touches the counter).
- Numbering is independent per outlet - a second outlet also starts at 1.

## CAP-8 - Manager authorisation gate

- **Intent:** void-after-fire, comp, discount-above-threshold, price
  override, refund, and no-sale drawer-open each require a manager's PIN
  plus a mandatory reason code before they take effect, and each writes an
  `audit_events` row (actor, approver, both timestamps, reason) in the same
  transaction as the mutation it gates (AD-15, generalizing AD-6).
- **Built** (`src/platform/manager-auth.service.ts`, exported from the
  `src/platform` barrel per AD-2): one shared, callable `ManagerAuthService`
  every gated mutation calls into, instead of six reimplementations of the
  same PIN-check-plus-audit-row logic. No controller/route of its own - this
  story shipped it with no caller in this codebase yet (see "How to call
  this" below); pos/CAP-10's shift module (also this doc) is the first `/pos`
  HTTP surface to exist, but it does not call this service (shift open/close
  and cash movements are not among CAP-8's six gated actions). Registered as
  a `PlatformModule` provider, so any module that already imports
  `PlatformModule` (every module in this app does) gets it via constructor
  injection with no extra module wiring.

### "Manager-capable" - the decision this story had to make

A StaffUser is manager-capable when their `Role.isManager` is `true` - a
new boolean column on `Role` (`prisma/schema.prisma`), **not** a hardcoded
`role.name === 'Manager'` string check. Seeded `true` for `'Owner'` and
`'Manager'` only, `false` for `'Cashier'`/`'Waiter'`/`'Kitchen'`/`'Accountant'`
(`SYSTEM_ROLES` in `src/ops/tenants/tenants.service.ts`, migration
`20260824960000_manager_authorisation` backfills existing tenants).

Why a flag over a name check: it's one string comparison cheaper today, but
tying authorisation to a display name couples it to a value tenant-admin/CAP-7
already lets an owner rename in principle, and a name check can't express
"Owner is also manager-capable" without hardcoding a second string. A flag on
`Role` means a tenant's set of approving roles can change later (e.g. letting
`Accountant` approve refunds) without touching `manager-auth.service.ts` at
all - the exact same "role property, not magic string" posture the codebase
already uses for `Role.isSystem`.

### Design decision - a callable service, not a guard/decorator

The task allowed either. A Nest guard runs before the route handler and has
no way to join the caller's own mutation transaction - but AD-6 requires the
audit row land in the **same transaction** as the mutation it gates. Splitting
this into two plain methods instead - `authorize()` (read-only, its own short
transaction, called before the caller's mutation) and `recordApproval()` (a
plain write the caller invokes **inside** its own transaction) - composes
with that requirement directly. A guard/decorator would need an awkward
side-channel to hand a transaction handle back out through Nest's request
pipeline, and couldn't be unit-tested without booting HTTP. This also means
every future call site calls it as two normal awaited method calls - no
decorator wiring, no metadata reflection to get wrong.

### How to call this (read this before wiring void/discount/refund/no-sale)

```ts
import { ManagerAuthService, MANAGER_GATED_ACTIONS } from '../platform'
// MANAGER_GATED_ACTIONS: ['void_after_fire', 'comp', 'discount_above_threshold',
//   'price_override', 'refund', 'no_sale_drawer_open'] - the ManagerGatedAction
// union type. Pass one of these six literals; a typo is a compile error.

// 1. Verify BEFORE your own mutation. Throws BadRequestException (empty/missing
//    reason - checked before the PIN, cheapest-check-first) or
//    UnauthorizedException (wrong PIN / PIN belongs to a non-manager / no
//    manager-capable staff exist for the tenant - all three look identical to
//    the caller and take the same time, by design, to avoid enumeration).
const approval = await this.managerAuth.authorize(
  'void_after_fire',   // actionType: ManagerGatedAction
  tenantId,            // string
  outletId,            // string - accepted for interface parity, not
                        // currently used to filter approvers (see below)
  dto.managerPin,       // string - the entered PIN, raw
  dto.reason,           // string - the mandatory reason code
)
// approval: { approverId, approverName, roleId, roleName, tenantId,
//             actionType, reason } - tenantId/actionType/reason are carried
// through from this call, so you never re-pass them to recordApproval below
// and they can't drift from what was actually verified.

// 2. Do your own mutation AND record the approval in ONE transaction (AD-6):
await plane.$transaction(async (tx) => {
  await setTenantContext(tx, tenantId)
  // ... your module's own mutation (void the line, apply the discount,
  //     issue the credit note, open the drawer) ...
  await this.managerAuth.recordApproval(tx, approval, {
    actorId: actingStaff.id,          // optional - the StaffUser who
                                       // triggered the action (not the
                                       // approving manager)
    actorEmail: actingStaff.email ?? actingStaff.name, // required by the
                                       // audit_events schema (actorEmail is
                                       // NOT NULL) - StaffUser.email is
                                       // optional, so fall back to name
                                       // yourself if it's unset
    occurredAt: new Date(),           // when the gated action happened
  })
})
```

- **outletId is accepted but not yet load-bearing.** `StaffUser` rows are
  tenant-scoped, not outlet-scoped, in this schema (SPEC: staff pick an
  outlet right after login, they aren't assigned to one) - so it currently
  plays no part in finding a candidate approver, and it is **not** persisted
  on the audit row either (`audit_events` has no outlet column). It's in the
  signature for parity with the money-path's outlet-scoped shape (AD-14) so
  every call site can pass the same request context uniformly. If your
  caller needs outlet context in its own trail, put it in your `reason`
  string or your own mutation's audit row - not this one.
- **The PIN check has no staff-selector input** - by design, matching CAP-1's
  PIN-login shape (a device knows a PIN, not which staff member typed it).
  `authorize()` loads every manager-capable, non-revoked `StaffUser` for the
  tenant and tries `argon2.verify` against each until one matches. Fine for
  the realistic size of a restaurant's manager roster; if that ever becomes a
  scaling concern, the query in `authorize()` is the one place to revisit,
  not the six call sites.
- **`action` written to `audit_events` is exactly the `actionType` you
  passed** - `'void_after_fire'`, `'comp'`, `'discount_above_threshold'`,
  `'price_override'`, `'refund'`, or `'no_sale_drawer_open'`. No domain
  prefix is added. If your module wants a more specific action string for
  its *own*, separate non-gated audit trail, write that as a second row -
  don't try to smuggle extra context into this one's `action` field.
- **`reason` is the one reason** - the mandatory reason code SPEC requires
  for the gated action IS the reason recorded on the approval's audit row.
  There is no separate "reason for the mutation" vs. "reason for the
  approval" - design your DTO with a single `reason` field.

### Test coverage (`test/manager-auth.e2e-spec.ts`, 6 tests, e2e against a
real Postgres test DB - no caller exists yet, so this story tests the
service directly rather than through an HTTP endpoint)

- Valid manager PIN + valid reason -> approved, with the correct approver
  identity returned.
- Wrong PIN -> rejected (`UnauthorizedException`).
- Missing/blank reason -> rejected (`BadRequestException`) with **no
  manager seeded at all** - proving the reason check runs before any PIN
  lookup (cheapest-check-first), not just that it eventually fails.
- A non-manager StaffUser's correct PIN -> rejected - proves `isManager`,
  not merely "has an active PIN", gates approval.
- A manager PIN from a different tenant never matches (cross-tenant
  isolation, RLS-backed).
- `recordApproval` writes actor, approver, reason, and both timestamps
  (`occurredAt`, `recordedAt`) into a real `audit_events` row, inside a
  transaction standing in for the caller's own mutation transaction.

## CAP-9 - Refunds and adjustments

- **Intent:** staff can refund one or more items against an already-
  finalized, immutable Bill (story 8), gated by story 9's manager
  authorisation, with correct tax reversal. Success: a refund never mutates
  the original Bill - it is issued as a separate, linked credit note read
  alongside the original Bill's totals, never overwriting them.
- **Built** (extending `src/pos/bills/` - no new module, per the
  architecture map's `pos/CAP-9 refunds & adjustments | pos/bills (credit
  notes)` row - not a parallel implementation):
  - Greenfield `CreditNote`/`CreditNoteLine` models (AD-14: the third
    insert-only money-path table pair after `Bill`/`Tender`; migration
    `20260825500000_refunds_credit_notes`). Nothing in `refund()` issues an
    `UPDATE` against `bills` or `tenders` - the "never mutates the original
    Bill" success criterion holds structurally, not just by convention.
  - `POST /pos/v1/bills/:id/refund` (201) -
    `{ managerPin, reason, lines?: [{ orderLineId, quantity }] }`. `lines`
    omitted refunds every order line's full remaining (not-yet-refunded)
    quantity - a whole-bill refund is the same itemized mechanism applied to
    every line, not a separate code path. `409 bill_not_finalized` against a
    still-`open` bill (refunds only make sense against something already
    finalized). Gated unconditionally by `platform/manager-auth`'s `'refund'`
    action (`ManagerAuthService.authorize('refund', tenantId, outletId,
    managerPin, reason)`, `.recordApproval()` inside the same transaction
    that creates the `CreditNote` - same call shape story 8's
    discount-above-threshold gate already uses, read from CAP-8's own "How
    to call this" section above, not guessed). Unlike story 8's discount
    gate (only above a threshold), a refund is always gated - so the request
    shape is validated first (bill state, line quantities) and the
    manager-PIN check runs only once a request is already known-valid, same
    cheapest-check-first ordering `manager-auth.service.ts` itself already
    uses for reason-before-PIN.
  - `GET /pos/v1/bills/:id` (unchanged) still reads the original Bill's own
    totals; a `CreditNote` is read separately by its own id/`originalBillId`
    (no new GET endpoint added this story - not required by SPEC or the
    tests below, and there's no existing "list credit notes" screen calling
    for one).
- **Itemization - against `OrderLine`, not a `Bill` line, because `Bill` has
  none of its own.** `Bill` stores only whole-bill aggregates
  (`subtotalMinor`/`taxMinor`/`discountMinor` - see its own comment block);
  the real per-item detail a bill's subtotal was computed from
  (`bills.service.ts`'s `computeSubtotal()`) lives one hop away, on the
  order's `OrderLine` rows (`unitPriceMinor`, `quantity`, modifiers). So
  `CreditNoteLine.orderLineId` points at `OrderLine` directly - this is real
  line-level detail the data actually supports, not the `amountMinor`+reason
  fallback the story brief allowed for if it didn't. Each `CreditNoteLine`
  snapshots `quantity` (units reversed) and `unitPriceMinor` (that line's own
  `unitPriceMinor` plus its modifiers' `priceMinor` total - the identical
  per-unit figure `computeSubtotal()` uses) so a later price change never
  retroactively alters an already-issued credit note.
- **Over-refund guard:** every earlier `CreditNoteLine` for the bill is
  summed per `orderLineId` before accepting a new refund, so a line can
  never be refunded past its original `OrderLine.quantity` across multiple
  credit notes - `400 over_refund` otherwise, naming exactly how many units
  remain. Not explicitly named in SPEC.md's success criterion, but a direct
  consequence of "itemized against the real order lines" - without it, the
  same dish could be refunded twice.
- **Correct tax reversal, against the real, documented placeholder rate -
  not a re-guessed one.** Story 8's `bills.service.ts` computes
  `taxMinor = subtotalMinor * TAX_RATE_PLACEHOLDER_PERCENT / 100` (5%,
  independent of any discount). `TAX_RATE_PLACEHOLDER_PERCENT` is now
  exported from `bills.service.ts` (was module-private) so `refund()`
  imports the exact same constant - never a second 5%, never a re-derived
  figure - and reverses each refund's `subtotalMinor` at that identical
  rate. Because the original tax was computed independent of discount, this
  is the correct inverse for a partial refund too, not an approximation.
  `CreditNoteView.totalMinor` (subtotal + tax) is derived, never persisted -
  same convention as `BillView.totalMinor`.
- **`CreditNote` schema/endpoint contract:**
  ```
  CreditNote { id, tenantId, originalBillId,
               reason, approvedByStaffId, createdByStaffId,
               subtotalMinor, taxMinor, createdAt }
  CreditNoteLine { id, creditNoteId, orderLineId,
                   quantity, unitPriceMinor, amountMinor }

  POST /pos/v1/bills/:id/refund   -> 201 CreditNoteView
    body: { managerPin, reason, lines?: [{ orderLineId, quantity }] }
  // CreditNoteView adds a derived `totalMinor` (subtotal + tax) and
  // `lines: CreditNoteLineView[]` - never persisted as its own column.
  ```

### Test coverage (`test/pos-refunds.e2e-spec.ts`, 7 tests, e2e against a
real Postgres test DB)

- A full refund (no `lines` given) creates a `CreditNote` with the correct
  subtotal/tax/lines, writes the real `audit_events` row via
  `platform/manager-auth`, and leaves the original `Bill` completely
  unchanged (status, number, totals all re-verified after).
- A partial refund of one unit computes the correct proportional tax
  reversal.
- Refunding more units than remain (across two credit notes) is rejected
  (`400 over_refund`) without creating a partial credit note.
- No manager PIN -> `400`; a wrong PIN -> `401`; either way, no `CreditNote`
  is created.
- A missing reason is rejected.
- A refund against a still-open (non-finalized) `Bill` is rejected (`409
  bill_not_finalized`), with no `CreditNote` created.
- Cross-tenant isolation: another tenant's bill id 404s, not a leaked
  refund.

## CAP-10 - Shift open, cash management, and blind-count close

- **Intent:** a cashier opens a shift with a starting float, logs cash
  movements (paid-outs, bank drops) through the shift, and closes it with a
  blind cash count - the counted amount is entered before the system reveals
  the expected amount, and the resulting over/short lands on an immutable
  end-of-shift record.
- **Built** (`src/pos/shifts/`), all under `/pos/v1/shifts` - the first real
  `/pos` HTTP surface in this codebase:
  - `POST /` -> `{ outletId, floatMinor }` (201). Rejects a second open shift
    on the same outlet with 409 `shift_already_open` - checked up front for a
    clear message, and backed by a partial unique index
    (`shifts_one_open_per_outlet` on `outlet_id WHERE closed_at IS NULL`,
    see the migration) that is the actual guarantee under a concurrent
    double-open race; the service catches the resulting unique-violation and
    reports the same 409.
  - `GET /current?outletId=` - the outlet's currently open shift (404 if
    none), for a reloaded/rejoined session that doesn't already know the
    shift's id.
  - `GET /:id` - one shift by id (open or closed), 404 across tenants.
  - `POST /:id/cash-movements` -> `{ type: "paid_out"|"bank_drop",
    amountMinor, reason }` (201). 409 if the shift is already closed - a
    cash movement can only ever be logged against an open shift.
  - `POST /:id/close` -> `{ countedMinor }` (200). **The single atomic call**
    this story's blind-count rule depends on: `expectedMinor` and
    `overShortMinor` are computed and written in this same transaction,
    together with `closedAt`/`closedByStaffId` - never before this call,
    never by a separate endpoint. 409 to close an already-closed shift (the
    counted/expected/overShort trio, once written, is never overwritten -
    AD-14's insert-only-past-finalisation rule for this table).
  - Every mutating action re-verifies the pos session's staff id against a
    real, tenant-owned `StaffUser` row before writing anything under their
    name (`assertStaffInTenant` in `shifts.service.ts`) - defense in depth,
    since the pos guard only checks the JWT signature/audience and never
    touches the database (see the pos-realm stub note below).
- **Blind-count enforcement (AD-14, the load-bearing requirement):**
  `expectedMinor`/`overShortMinor` are `null` on every read of an open shift
  (`GET /current`, `GET /:id`, and the response of every
  `POST /:id/cash-movements` call) because the DB columns themselves are
  `null` until `close()` runs - there is no code path anywhere in this
  service that computes an expected figure ahead of a counted amount being
  supplied, and no "peek" endpoint exists. Proven directly in
  `test/shift-cash-management.e2e-spec.ts`'s "blind-count enforcement"
  suite, not just asserted.
- **Expected-amount formula was deliberately partial when this story
  shipped** (`expectedMinor = floatMinor - sum(paid_out) -
  sum(bank_drop)`, since `Order`/`Bill`/`Tender` didn't exist in the schema
  yet - greenfield alongside this story, per AD-14's table list; story
  3/issue #46 built `Order` independently). **Completed by pos/CAP-7 (Bill &
  Settle, issue #59):** the formula is now `floatMinor + sum(cash-tender
  bill totals finalised at this outlet since the shift opened) -
  sum(paid_out) - sum(bank_drop)` - see that story's own entry above for the
  detail (`Tender` carries no `shiftId`; the outlet + "finalised since
  `openedAt`" filter is unambiguous because only one shift is ever open per
  outlet at a time).
- **Pos-realm auth - reconciled with pos/CAP-1 (issue #44).** This story was
  built before pos/CAP-1's real PIN login merged, so it originally shipped
  its own e2e-only stub of `src/platform/pos-jwt.ts`/`pos-auth.guard.ts`
  (tokens signed directly via `signPosToken` in tests, no real login). That
  reconciliation is now done automatically by rebasing onto `dev` after #44
  merged: this story's own commit never touched `pos-jwt.ts`/
  `pos-auth.guard.ts` (it only consumed `CurrentStaff`/`PosPrincipal`), so
  the real, merged implementation (`{ id: staffId, tenantId, outletId, name
  }`, signed by pos/CAP-1's real login/select-outlet endpoints) is what this
  story's `/pos/v1/shifts/*` routes run against - no code change was needed
  here, only this note.
- **Not gated by CAP-8's manager-authorisation service** - shift open/close
  and cash movements are not among the six actions AD-6/AD-15 name (only
  no-sale drawer-open, a distinct future action this story does not
  implement, is in the shift/cash domain). See "Key decisions" below.

## CAP-11 - Device and staff attendance status

- **Intent:** staff or a manager can see who is clocked in on this device
  (outlet) today, plus the device's own (mocked) printer/connectivity
  status, since there is no real hardware in this prototype. Success:
  the list reflects real CAP-1 `ClockEvent` rows for today - no fabricated
  staff or times.
- **Pure read story, no new mutation model** (stories.yaml story 11) -
  built entirely on story 1's `ClockEvent` rows.
- `GET /pos/v1/outlets/:outletId/attendance`
  (`src/pos/clock/attendance.controller.ts`,
  `src/pos/clock/attendance.service.ts`, wired into `PosModule` alongside
  the rest of `src/pos/clock/`) returns:
  ```json
  {
    "outletId": "…",
    "asOf": "2026-08-25T10:40:00.000Z",
    "staff": [{ "staffId": "…", "name": "Asha", "clockedInAt": "…" }],
    "printerStatus": { "status": "connected", "mocked": true }
  }
  ```
- **"Clocked in" derivation:** for each staff member, take their latest
  `ClockEvent` at this outlet; they're listed iff that event is a
  `clock_in` **and** it falls on today's local calendar day in the
  outlet's own timezone (`Outlet.timezone`). Reuses
  `clock.util.ts#localDateKey` verbatim - the exact same "today" CAP-1's
  own once-per-day clock-in already relies on - rather than
  reimplementing local-day logic a second time. A staff member's second
  clock-in on the same day never produces a duplicate entry: events are
  read newest-first and only the first (latest) event per `staffId` is
  considered.
- Query is bounded to the last 48 hours (`LOOKBACK_HOURS` in
  `attendance.service.ts`) rather than scanning the whole insert-only
  `clock_events` table - wide enough to contain "today" in any IANA
  timezone (max UTC offset spread is +14/-12) without unbounded growth
  over time. A stale open clock-in from an earlier local day (staff never
  clocked out, then simply didn't log in again) correctly falls out of
  the list once its calendar date no longer matches today's.
- **Mocked printer status, honestly labeled:** `printerStatus.status` is
  a hardcoded `'connected'` string, never a real ESC/POS or peripheral
  check (SPEC.md Constraints: no real hardware integration in this
  prototype) - `mocked: true` on the same object keeps that unmistakable
  to any consumer, and a code comment on `MockedPrinterStatus`
  (`attendance.dtos.ts`) explains why. Same honesty discipline as the
  owner dashboard's `hasData`/`message` convention
  (`admin/dashboard/dashboard.service.ts`), adapted to this field's shape
  since there's no "amount" here to null out - a boolean flag plus a
  fixed value is the equivalent for a mocked status rather than a mocked
  number.
- Outlet-scoped like every other `/pos` read: 404s (not a different
  shape) for an outlet from another tenant, same as `table-map`/`orders`.
  Not scoped by the caller's own `outletId` claim - any staff member in
  the tenant can read any of the tenant's outlets' attendance, matching
  `GET /pos/v1/outlets/:outletId/table-map`'s existing posture.

### Test coverage (`test/pos-attendance.e2e-spec.ts`, 9 tests, e2e against
a real Postgres test DB)

- A staff member who clocked in and hasn't clocked out shows up.
- A staff member who has clocked out is excluded.
- Two clock-ins on the same day (in, out, in again) produce exactly one
  entry, not two.
- A stale open clock-in from an earlier local day is excluded.
- Multiple currently-clocked-in staff are listed, sorted by name.
- A staff member clocked in at a different outlet in the same tenant
  never appears in this outlet's list.
- `printerStatus` is always present and exactly `{ status: 'connected',
  mocked: true }`.
- No pos session -> `401`; another tenant's outlet -> `404`.

## Data model

- `clock_events` (CAP-1, new table) - `id`, `tenantId`, `staffId`,
  `outletId`, `type` (`clock_in`/`clock_out`), `occurredAt`, `createdAt`.
  RLS-protected like every other tenant-owned table. Insert-only: a day's
  attendance is a sequence of events, never edited in place.
- `roles.is_manager` (CAP-8, new column, default `false`) - see
  "manager-capable" above. Migration `20260824960000_manager_authorisation`
  adds it and backfills `true` for existing `'Owner'`/`'Manager'` rows.
- `audit_events.approver_id` / `audit_events.approver_name` (CAP-8, new,
  nullable columns) - populated only for manager-gated audit rows; `null`
  for every routine AD-6 audit action that has no approval step (e.g.
  `staff.role_changed`, `staff.pin_revoked`). `approverName`, not
  `approverEmail`: the approving `StaffUser`'s email is optional but name is
  required, so name is what's guaranteed to identify them. No RLS policy
  change needed - both are plain additive columns on a table whose existing
  `tenant_id`-scoped policies already cover them.
- `shifts` (new, CAP-10) - `{ id, tenantId, outletId, openedByStaffId,
  floatMinor, openedAt, closedByStaffId?, closedAt?, countedMinor?,
  expectedMinor?, overShortMinor? }`. RLS `tenant_isolation` +
  `operator_read` (AD-5), same posture as every other tenant-owned table.
  `closedByStaffId`/`closedAt`/`countedMinor`/`expectedMinor`/
  `overShortMinor` are set together, exactly once, only by
  `ShiftsService.closeShift()` - nothing else in this codebase writes them,
  and there is no UPDATE path back to `null` once set. **One open shift per
  outlet at a time** is enforced by a partial unique index,
  `shifts_one_open_per_outlet` on `(outlet_id) WHERE closed_at IS NULL` -
  hand-written in the migration SQL, since Prisma's schema DSL has no
  partial-index syntax (same reason RLS policies live in migration SQL
  rather than `schema.prisma`).
- `cash_movements` (new, CAP-10) - `{ id, tenantId, shiftId, type (paid_out |
  bank_drop), amountMinor, reason, createdByStaffId, createdAt }`. RLS
  `tenant_isolation` + `operator_read`. Insert-only, like every other
  money-path row under AD-14 - there is no update/delete path for a logged
  movement anywhere in this service.
- Money is `bigint` minor units on both new CAP-10 tables (workspace
  convention); DTOs/views convert to/from plain JS `number` at the API
  boundary, same pattern as `item_prices.priceMinor` in the tenant-admin
  menu module.
- CAP-11 adds **no table or column** - it is a pure read over CAP-1's
  existing `clock_events`, per stories.yaml story 11.
- `bills` (new, CAP-7) - `{ id, tenantId, outletId, orderId (unique),
  billNumber? (null until finalised), subtotalMinor, taxMinor,
  discountMinor?, discountReason?, status (open|finalized),
  createdByStaffId, createdAt, finalizedByStaffId?, finalizedAt? }`. RLS
  `tenant_isolation` + `operator_read`. Insert-only past finalisation (AD-14)
  - `BillsService.finalize()` is the sole writer of `billNumber`/
  `discountMinor`/`discountReason`/`status`/`finalizedByStaffId`/
  `finalizedAt`, and always via a `status='open'` compare-and-swap `UPDATE`,
  never a plain update-by-id. Unique on `(tenantId, outletId, billNumber)` -
  a plain (non-partial) index, since Postgres already treats every `NULL`
  `billNumber` as distinct.
- `tenders` (new, CAP-7) - `{ id, tenantId, billId, method (cash |
  upi_manual), amountMinor, createdAt }`. RLS `tenant_isolation` +
  `operator_read`. Insert-only, like every other money-path row under
  AD-14 - no update/delete path for a tender once written.
- `bill_number_counters` (new, CAP-7) - `{ id, tenantId, outletId (unique),
  lastNumber }`. One row per outlet, incremented by a plain transactional
  `UPDATE`/`upsert` inside `finalize()`'s own transaction - deliberately not
  a Postgres `SEQUENCE` (see CAP-7's own entry above for why). RLS
  `tenant_isolation` + `operator_read`.
- Money is `bigint` minor units on all three new CAP-7 tables, same
  workspace convention as every other money-path table.
- `orders.token_number` (new column, CAP-6) - `Int?`, `null` on every table
  (dine-in) order, assigned once at creation for a counter order
  (`tableId: null`) by `OrdersService.createCounterOrder()`. Unique on
  `(tenantId, outletId, tokenNumber)`, same plain-(non-partial)-index-plus-
  every-NULL-is-distinct posture as `bills.bill_number`.
- `token_number_counters` (new, CAP-6) - `{ id, tenantId, outletId (unique),
  lastNumber }`. One row per outlet, incremented by a plain transactional
  `UPDATE`/`upsert` inside `createCounterOrder()`'s own transaction -
  deliberately not a Postgres `SEQUENCE` (see CAP-6's own entry above for
  why), and a separate table from `bill_number_counters` rather than a
  second column on it (the two sequences are reserved at different moments
  by different services). RLS `tenant_isolation` + `operator_read`, same
  posture as every other tenant-owned table.

## Integration points for later stories

- **For CAP-8's manager authorisation:** every gated mutation (order
  void-after-fire and comp, bill discount-above-threshold and price
  override, refund, shift no-sale drawer-open) calls
  `ManagerAuthService.authorize()` then `.recordApproval()` exactly as shown
  above - **never** a per-action PIN check or a second `audit_events` insert
  helper. None of those future call sites need to touch `Role.isManager` or
  `AuditEvent.approverId`/`approverName` directly - `ManagerAuthService` is
  the only reader/writer of those columns. If a future product decision
  wants a role beyond Owner/Manager to approve gated actions, flip that
  role's `isManager` to `true` (a data change) - `manager-auth.service.ts`
  needs no code change for that.
- **pos/CAP-1 (issue #44):** see CAP-10's "pos-realm auth is a stub" note
  above - this is the first thing to reconcile once that story lands; it
  also unblocks a real caller for CAP-8's `ManagerAuthService` (PIN-login
  needs no manager gate itself, but every screen built after it will).
- **pos/CAP-10's own no-sale drawer-open action** (not built by this story)
  is the natural first caller of `ManagerAuthService` from within the shift
  module, once it's dispatched.
- **CAP-6 (QSR counter & token) is now built** (issue #62) - exactly the
  composition CAP-7's own entry above anticipated: a token-issuing wrapper
  (`POST /pos/v1/outlets/:outletId/counter-orders`) around the
  already-existing `POST /pos/v1/orders/:orderId/bill` + `.../finalize`, with
  no second bill/settle code path added. See CAP-6's own doc entry above for
  the full call sequence and the token-numbering mechanism.
- **For CAP-9 (refunds & adjustments, not yet dispatched):** reads a
  finalised `Bill`'s real `subtotalMinor`/`taxMinor`/`discountMinor`/
  `tenders` to compute tax reversal, and is gated by CAP-8's
  `ManagerAuthService` the same way CAP-7's discount step is - a `CreditNote`
  is a new, separate insert-only table linked by `originalBillId` (AD-14),
  never a `Bill`/`Tender` mutation; nothing in `bills.service.ts` needs to
  change to support it.
- No pos capability besides the ones named above reads or writes
  `shifts`/`cash_movements`/`roles.is_manager`/`audit_events.approver_*`/
  `bills`/`tenders`/`bill_number_counters` yet.

## Key decisions

- AD-13 explicitly does **not** bind a pos session to an enrolled Device
  row (unlike AD-12's real device model) - any authenticated browser can
  act as a POS terminal in this prototype. Logged, deliberate, prototype-
  only relaxation; the native Android build must bind sessions to real
  enrolled devices.
- `StaffUser` has no `outletId` column (it's tenant-wide), which is why
  CAP-1's login is two-step rather than embedding the outlet in the PIN
  check itself - the outlet is resolved after the PIN, not as part of it.
- The intermediate outlet-selection token reuses `POS_JWT_SECRET` rather
  than introducing a fifth secret - realm separation is enforced by
  **audience** (`pos` vs `pos-pending`), the same "distinct audience, not
  necessarily a distinct key" shape AD-3/AD-10 already use for keeping
  their own two audiences on two different secrets, extended one step
  further within a single realm's own login handshake.
- `pinStatus()` is reused across the module boundary rather than
  reimplemented: it is now exported from `admin/index.ts` (a pure function,
  safe to share per AD-2's barrel rule). `setTenantContext` is instead
  duplicated as `src/pos/tenant-context.ts` and, separately, into
  `manager-auth.service.ts` - that one-line RLS helper is already
  copy-pasted per admin submodule in this codebase (see its own comment),
  and neither `pos` nor `platform` may import it from `admin` regardless
  (`admin` already imports `platform`; the reverse would be circular) - the
  ponytail "one line? one line" step, applied consistently.
- CAP-8's own `manager-auth.service.ts` shipped no `/pos` HTTP module,
  controller, or DTO of its own - it is exactly AD-15's shared service and
  nothing else, with no caller in this codebase yet. (CAP-2 merged before
  CAP-1 did and, needing a guard to sit behind, temporarily stubbed its own
  copy of the pos realm; that stub has since been reconciled away in favour
  of CAP-1's real implementation - see "The pos auth realm" under CAP-2
  above. `manager-auth.service.ts` remains a plain service with no
  controller/route of its own - every future gated mutation calls into it
  directly, per "How to call this" above.)
- `ManagerGatedAction` is a closed TypeScript union (`MANAGER_GATED_ACTIONS`),
  not a free-text `string`, so the four future call sites get a compile-time
  guardrail against a typo silently producing an unrecognised `action` value
  in `audit_events`.
- `authorize()` does one dummy `argon2.verify` on every failure path (wrong
  PIN, non-manager PIN, or zero manager-capable staff), mirroring
  `OpsAuthService.dummyHash` (and CAP-1's own `PosAuthService.dummyHash` -
  same reasoning, applied independently) - so a caller can't learn from
  response timing whether a given tenant has any managers/staff at all.
- `setTenantContext` is duplicated per realm rather than imported across
  module boundaries - CAP-8 duplicated it into `manager-auth.service.ts`
  (that 3-line helper is already copy-pasted per admin submodule in this
  codebase, and `platform` must not import from `admin` regardless: `admin`
  already imports `platform`, so the reverse would be circular). CAP-10
  independently made the same call for the same reason, duplicating it into
  `src/pos/tenant-context.ts` rather than reaching into `src/admin/menu/`'s
  copy - AD-4's cross-realm-import rule (no reaching into another realm's
  module tree) extends to this backend module layout, not just restiq-web's
  route groups.
- One open shift per outlet, enforced both ways (pre-check for a clear
  error message, partial unique index for the actual race-safe guarantee) -
  the SPEC left the enforcement mechanism to the builder; a DB-level
  constraint is what "enforce it" has to mean once two terminals could
  plausibly race to open a shift for the same outlet at the same moment.
- `expectedMinor`/`countedMinor`/`overShortMinor` are nullable columns on
  the same `shifts` row (not a separate `EndOfShiftRecord` table) - the
  SPEC calls for "an immutable end-of-shift record", and a shift already
  has exactly one lifecycle (open -> closed) with exactly one close event;
  splitting it into a second table would need a 1:1 join for no isolation
  benefit, since the insert-only guarantee is enforced at the application
  layer (one write, in `closeShift()`, ever touches those columns) rather
  than by table boundaries.
- `CashMovement.reason` is a required plain string, not a reason-code enum -
  the SPEC's CAP-8 manager-authorisation actions (void, comp, discount,
  price override, refund, no-sale) use mandatory reason codes, but shift
  open/close and cash movements are explicitly *not* one of CAP-8's six
  gated actions (confirmed against AD-6/AD-15's binds lists, which name only
  the six) - so this story asks for a reason string, not a coded reason,
  and does not call the shared `platform/manager-auth` service or write an
  `audit_events` row for any CAP-10 action.
- **`PosPrincipal`'s real shape (`{ id, tenantId, outletId, name }`, settled
  by pos/CAP-1/issue #44) carries `outletId` on the token itself** - this
  story's own endpoints still take `outletId` explicitly in the request body
  /query rather than trusting the token's claim, since every shift action is
  already scoped through the shift's own stored `outletId` once one exists
  (`GET /current?outletId=`, `POST /`). No code change was needed here; this
  replaces an earlier note in this doc that guessed a narrower, no-`outletId`
  claim shape before #44 settled the real one.
- No manager-PIN gate on shift open/close or cash movements - per this
  story's dispatch notes, AD-6's mutation-and-audit reference binds CAP-8's
  six named actions, and shift/cash-management is not among them.
- CAP-11's attendance list is derived, not stored - "clocked in" is
  computed fresh on every request from `clock_events` (latest event per
  staff = clock_in, dated today) rather than maintained as a live flag on
  `StaffUser`. A derived read keeps this story genuinely mutation-free
  (per its dispatch note) and can never drift from CAP-1's actual
  clock-in/out history, at the cost of one bounded query per read - an
  acceptable tradeoff for a per-outlet attendance panel, not a hot path.
- CAP-11's mocked printer status is a plain object literal
  (`{ status: 'connected', mocked: true }`), not a richer per-printer
  model keyed off the existing `printers` table (CAP-6/CAP-5's floor-plan
  work) - the SPEC explicitly scopes this to "a mocked printer/
  connectivity status", singular and static, with no real device driver
  call in this prototype; wiring it to real `Printer` rows would imply a
  liveness check this codebase has nowhere to perform.
