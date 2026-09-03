# Completed

- **2026-09-03** - Country-aware tax engine, bill tax snapshot, and
  tax-invoice view. New pure `src/pos/bills/tax.ts` (`computeTax()`,
  `bigint` minor units, deterministic round-half-up rounding) replaces the
  old flat 5% `TAX_RATE_PLACEHOLDER_PERCENT`: IN CGST 2.5% + SGST 2.5%
  (IGST profile: single IGST 5%; composition scheme: 0% + the statutory
  note), AU GST 10% tax-inclusive. `bills.tax_breakdown` (nullable JSONB)
  and `bills.prices_include_tax` (boolean, default false) snapshot the
  engine's result once at bill creation, never recomputed afterwards -
  `taxMinor` stays the authoritative total so existing readers keep
  working. New `GET /pos/v1/bills/:id/invoice` (and guest-realm
  `GET /guest/v1/bills/:id/invoice`) returns a read-only `InvoiceView`
  (seller detail, resolved order lines, tax breakdown, tenders, credit
  notes) for an already-finalized bill, `409 not_finalized` before that.
  CAP-9's refund tax reversal now derives its rate from the bill's own
  `subtotalMinor`/`taxMinor` ratio instead of the old fixed placeholder, so
  it stays correct under every tax regime. 20 new tests (`tax.spec.ts`'s
  unit coverage of every branch + rounding edge cases, and
  `pos-bills.e2e-spec.ts`'s IN/AU/composition/invoice/cross-tenant e2e
  cases). See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md#cap-7---bill-and-settle).
  Issue AusPosRest/restiq-backend#103.
- **2026-09-02** - Made seat assignment optional end to end: removed
  pos/CAP-4's `assertAllLinesSeated` fire gate, so `PATCH
  /pos/v1/orders/:orderId/status {status:'sent'}` no longer rejects
  `400 unseated_lines` - unseated lines fire normally and their tickets
  simply carry `seatNumber: null`. `seatNumber` itself is untouched: still
  optional metadata on `POST`/`PATCH` order lines, no schema/migration
  change (the column was already nullable). qr-self-order's guest
  auto-seat-by-join-order behaviour (issue #77) is unaffected, kept as-is.
  Product decision - the per-line seat requirement was too much ceremony
  for staff at send time. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md#cap-4---group-ordering-seats-and-covers).
  Issue AusPosRest/restiq-backend#101.
- **2026-09-02** - Made `POST /pos/v1/orders/:orderId/bill` (and its guest
  counterpart, `POST /guest/v1/orders/:orderId/bill`) idempotent per orderId:
  a call for an order that already has a Bill now returns it unchanged with
  200 (same `BillView`/`GuestBillView` shape, same id, no second row -
  never merged), instead of a bare `409 bill_already_exists` with no bill
  id to recover from. Fixes the web settle screen breaking in a fresh tab
  (its only prior way to find a bill was a `sessionStorage`-cached id, lost
  on a fresh tab). `bill-core.ts`'s `createBillRecord` became
  `createOrGetBillRecord`, returning `{ bill, created }`; the concurrent-
  create race is still caught by the schema's unique `orderId` (AD-11/
  AD-14: never a second Bill row), just turned into the same idempotent
  return instead of a raw constraint error. No new route added - the
  existing POST covers the fresh-tab case once it's idempotent. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md#cap-7---bill-and-settle).
  Issue AusPosRest/restiq-backend#98.
- **2026-09-02** - POS projections: `floorName` on `TableMapEntry` and
  `tableLabel` on `OrderView` (additive, non-breaking - no existing field
  renamed or removed). Fixes the POS web showing raw UUIDs instead of
  human-readable floor/table names. `floorName` is the owning `Floor.name`,
  added to `getTableMap()`'s table query; `tableLabel` is the `DiningTable
  .label` for a dine-in order (`null` for a counter order), resolved once
  inside `buildOrderView()` so every order read/mutation endpoint carries it.
  See [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md#name-projections-issue-94-additive).
  Issue AusPosRest/restiq-backend#94.
- **2026-08-24** - Tenant Admin story 1: owner invite acceptance (CAP-1) and
  go-live checklist API (CAP-2). `POST /admin/v1/auth/accept-invite`,
  `GET /admin/v1/checklist`, `PATCH /admin/v1/checklist/:step`,
  `POST /admin/v1/checklist/go-live`. New `/admin` auth realm (AD-10,
  `aud:"admin"`), `owner_users` and `checklist_progress` tables. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#26.
- **2026-08-24** - Tenant Admin story 2: AI-assisted menu import (CAP-3).
  `POST /admin/v1/menu-import/upload` (real CSV/XLSX parsing, stubbed
  image/PDF), `PATCH /admin/v1/menu-import/:importId` (review/edit),
  `POST /admin/v1/menu-import/:importId/commit` (atomic catalogue write +
  checklist flip). New `item_prices` table (AD-11, insert-only price
  history - binds every writer, including the story-1 sample-menu seed,
  which was updated to match) and `menu_import_drafts` table; `menu_items`
  gained `short_name` (PRD FR-10) and lost its price columns. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#28.
- **2026-08-24** - Tenant Admin story 3: menu management with versioned
  pricing (CAP-4). Full CRUD under `/admin/v1/menu` for categories, items
  (with variants, modifier groups, allergen tags nested), modifier groups,
  allergens, and combos; `item_prices` (story 2) extended with
  `variantId`/`outletId`/`channel`/`effectiveAt` dimensions and a
  well-tested current-price resolution query (`menu/pricing.ts`); the 86
  availability toggle and a per-outlet availability override; new tables
  `item_variants`, `modifier_groups`, `modifiers`, `item_modifier_groups`,
  `allergens`, `item_allergens`, `combos`, `combo_components`,
  `item_outlet_overrides`. Price edits are audited (`menu.item.price_changed`,
  reason required) per the SPEC's security-relevant list; routine content
  CRUD is not. See [wiki/features/tenant-admin.md](../features/tenant-admin.md).
  Issue AusPosRest/restiq-backend#30.
- **2026-08-24** - Tenant Admin story 4: branding & capability toggles, outlet
  listing (CAP-10). `GET /admin/v1/outlets` (the outlet-switcher endpoint
  story 3's web half needs - `{ id, name, address, type, timezone }`, no
  schema change, reads the existing `outlets` table), `GET`/`PUT
  /admin/v1/branding` (reads/merges into the existing
  `tenants.branding_tokens` JSON column), `GET /admin/v1/outlets/:id/capabilities`
  / `PATCH /admin/v1/outlets/:id/capabilities/:key` (new `outlet_capabilities`
  table, distinct from Platform Console's tenant-wide `tenant_capabilities`).
  All three are routine content edits per the SPEC - no audit reason
  required. See [wiki/features/tenant-admin.md](../features/tenant-admin.md).
  Issue AusPosRest/restiq-backend#32.
- **2026-08-24** - Tenant Admin story 5: floor plan & stations (CAP-5).
  Full CRUD under `/admin/v1/outlets/:outletId/floor-plan` for floors,
  tables (with 409 `table_overlap` on overlapping bounds - reject, not
  auto-adjust, this story's call on the SPEC's open question), printers,
  and stations (400 `printer_required` unless a printer is set or
  `noPrinterAcknowledged: true` is sent). New tables `floors`,
  `dining_tables`, `printers`, `stations` (stations carry
  `primaryPrinterId`/`fallbackPrinterId` directly, no join table). The
  first table created for an outlet flips the `floor_plan` checklist step.
  See [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#34.
- **2026-08-24** - Tenant Admin story 6: devices & printers (CAP-6).
  `GET /admin/v1/outlets/:outletId/devices`,
  `POST /admin/v1/outlets/:outletId/devices/enrolment-codes` - a thin
  tenant-scoped wrapper (`src/admin/devices/`) around Platform Console's
  `DevicesService` (AD-12: one enrolment implementation, two callers, now
  exported from `src/ops` for this reuse); no new device/enrolment-code
  logic. `GET`/`PATCH /admin/v1/outlets/:outletId/floor-plan/printers(/:id)`
  added to story 5's floor-plan module for printer render-mode (fallback was
  already covered by `Station.fallbackPrinterId`). The go-live checklist's
  `devices` step now flips inside the shared `enroll()` method itself, on
  the tenant's first device. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md) and
  [wiki/features/platform-console.md](../features/platform-console.md).
  Issue AusPosRest/restiq-backend#36.
- **2026-08-24** - Tenant Admin story 7: staff & roles (CAP-7). New
  `src/admin/staff/` module: `GET /admin/v1/roles` (the six seeded system
  roles), `GET`/`POST /admin/v1/staff`, `PATCH /admin/v1/staff/:id`,
  `POST /admin/v1/staff/:id/pin` (issues a random 4-digit PIN, argon2-hashed,
  returned once), `POST /admin/v1/staff/:id/revoke-pin` (`{ reason }`
  required, 400 without one, audited per AD-6, 409 if there's no active PIN
  to revoke). New `staff_users` table, FK'd to the existing `roles` table -
  `roleId` is checked against the tenant's own seeded `isSystem` roles
  before every create/update (400 otherwise), so no free-text role is ever
  assignable. Staff creation/editing is a routine content edit, not audited;
  only PIN revoke carries a reason and an `audit_events` row. The go-live
  checklist's `staff` step flips on the tenant's first staff member. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#38.
- **2026-08-24** - Tenant Admin story 8: owner dashboard (CAP-8). New
  `src/admin/dashboard/` module: `GET /admin/v1/dashboard` -> per-outlet
  `deviceCount` plus `sales`/`margin`/`labourCost`/`waste`, a tenant rollup
  (`outletCount`, `staffCount`, `menuItemCount`, `deviceCount`, `status`,
  `goLiveAt`), and a real `asOf` timestamp. **Deliberately ships no live
  sales/margin/labour/waste data** - grepping the schema confirmed RESTIQ's
  POS Core Loop (the Order/Bill/Payment surface) hasn't been built yet, so
  there is no transactional source to aggregate from. Every financial
  metric is an honest `{ amountMinor: 0, currency, hasData: false, message
  }` rather than a fabricated number or an omitted field. `staffCount`/
  `menuItemCount` are tenant-rollup-only, not per-outlet - `staff_users`
  has no outlet linkage and `menu_items` is one shared tenant catalog, so a
  per-outlet split would be fabricated; only `deviceCount` genuinely has
  outlet granularity. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#40.
- **2026-08-24** - Tenant Admin story 9: reports catalogue (CAP-9). New
  `src/admin/reports/` module: `GET /admin/v1/reports` (the report
  catalogue), `GET /admin/v1/reports/menu-catalogue/export?format=csv`,
  `GET /admin/v1/reports/staff-roster/export?format=csv`, and
  `GET /admin/v1/reports/export-destinations`. **Explicitly honest, not an
  oversight:** Sales, Financial (GST/BAS), Menu Engineering, Operations,
  Inventory, and Labour-cost reports all depend on transactional
  Order/Bill/Payment/Document data that doesn't exist yet (POS Core Loop
  unbuilt) - each is listed with `hasData: false`, "Available once POS Core
  Loop is live", and `exportFormats: []`, never fabricated content or a
  shadow transactional model. Two report types ARE real and export a real
  CSV: **Menu Catalogue** (CAP-4's live menu/prices) and **Staff Roster**
  (CAP-7's live staff/roles). The accounting export-destination picker
  (Tally/Xero/MYOB/Zoho/QuickBooks) is a static list, every destination
  honestly `"not_connected"` - no OAuth/API integration to any of them
  exists in this codebase. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#42.
- **2026-08-25** - POS Cashier & Waiter story 1: PIN login and shift clock
  (CAP-1). New fourth disjoint auth realm `pos` (AD-13, `aud:"pos"`, own
  secret `POS_JWT_SECRET`, principal `{ id: staffId, tenantId, outletId }`),
  `PosAuthGuard` registered globally alongside the ops/admin guards.
  `POST /pos/v1/auth/login` verifies a 4-digit PIN against active
  `StaffUser` rows for the tenant (reusing `pinStatus()`/argon2 verbatim);
  single-outlet tenants finalise immediately, multi-outlet tenants get a
  short-lived `pos-pending`-audience token plus an outlet list, finalised by
  `POST /pos/v1/auth/select-outlet`. 5 wrong attempts for the exact
  `(tenantId, pin)` pair locks it for 30s (`429 locked_out`, in-memory,
  documented single-instance tradeoff). New `ClockEvent` model
  (RLS-protected); a successful login records a clock-in unless one is
  already open for today in the outlet's own timezone;
  `POST /pos/v1/clock/out` ends it (`409 not_clocked_in` otherwise). See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#44.
- **2026-08-25** - POS Cashier & Waiter story 3: table map and order
  ownership/transfer (CAP-2). New `src/pos/` module (first `/pos` HTTP
  surface): `GET /pos/v1/outlets/:outletId/table-map` (reuses tenant-admin/
  CAP-5's `Floor`/`DiningTable` models, no second table model),
  `POST /pos/v1/outlets/:outletId/tables/:tableId/order` (open/claim, never
  a takeover), `GET /pos/v1/orders/:orderId` (view, any staff),
  `PATCH /pos/v1/orders/:orderId/status` (owner-only, `open -> sent ->
  closed`), `POST /pos/v1/orders/:orderId/transfer` (explicit handoff,
  callable by anyone, audited). New greenfield `orders` table (base fields
  only - no `OrderLine` yet) with a partial unique index enforcing at most
  one live order per table. Stubbed the `/pos` auth realm
  (`src/platform/pos-jwt.ts`, `pos-auth.guard.ts`, `aud:"pos"`) ahead of
  pos/CAP-1's real PIN login (issue #44, not yet merged) - flagged for
  reconciliation once that story lands. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#46.
- **2026-08-25** - POS Cashier & Waiter story 9: manager authorisation gate
  (CAP-8, AD-15). New `src/platform/manager-auth.service.ts`
  (`ManagerAuthService`, barrel-exported from `src/platform`) - one shared
  service for all six gated actions (void-after-fire, comp,
  discount-above-threshold, price override, refund, no-sale drawer-open),
  no per-action reimplementation. `authorize()` verifies a manager PIN
  (argon2, same convention as `staff_users.pin_hash`) against every
  manager-capable `StaffUser` in the tenant and returns the approver's
  identity; `recordApproval()` is a helper the caller invokes inside its own
  mutation transaction to write the `audit_events` row (AD-6). New
  `Role.isManager` column (seeded `true` for 'Owner'/'Manager' only - a flag,
  not a hardcoded role-name check) and new `audit_events.approverId`/
  `approverName` columns. No `/pos` HTTP surface yet - this is pure shared
  infrastructure with no caller in this codebase, tested directly
  (`test/manager-auth.e2e-spec.ts`, 6 tests). See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md)
  for the full "how to call this" contract the next four stories need.
  Issue AusPosRest/restiq-backend#47.
- **2026-08-25** - POS Cashier & Waiter story 2: shift open, cash
  management, and blind-count close (CAP-10). New `src/pos/` module and
  `/pos` auth realm (AD-13, `aud:"pos"` - stubbed pending issue #44's real
  PIN-login, which hadn't landed when this story started): `POST
  /pos/v1/shifts` (409 on a second open shift for the same outlet, backed by
  a partial unique index), `GET /pos/v1/shifts/current`, `GET
  /pos/v1/shifts/:id`, `POST /pos/v1/shifts/:id/cash-movements` (paid-out /
  bank-drop), `POST /pos/v1/shifts/:id/close`. The close endpoint is the one
  atomic call that computes and stores `expectedMinor`/`overShortMinor`
  together with the counted amount - **no endpoint or response field ever
  exposes an expected figure before that call**, proven directly in
  `test/shift-cash-management.e2e-spec.ts`. New `shifts`/`cash_movements`
  tables (AD-14, insert-only past finalisation). Expected-amount is
  `float - paid_outs - bank_drops` only for this story - `Order`/`Bill`/
  `Tender` don't exist yet; a TODO in `ShiftsService.closeShift()` marks
  where the Bill & Settle story folds in real cash-tender totals. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#45.
- **2026-08-25** - POS Cashier & Waiter story 6: open and held orders,
  outlet-wide (CAP-5). New `GET /pos/v1/outlets/:outletId/orders` on
  story 3/CAP-2's existing `OrdersService`/`PosOrdersController` - no new
  module. Returns every non-`closed` `Order` in the outlet, table-tied or
  counter (`tableId: null`) alike, unlike CAP-2's `GET .../table-map` which
  only shows table-tied orders. Take-over reuses CAP-2's real `POST
  /pos/v1/orders/:orderId/transfer` unchanged - no second ownership
  mechanism was added. pos/CAP-3 (order taking, issue #52) had not merged
  as of this story's build, so `OrderLine` doesn't exist yet; SPEC.md
  doesn't require an item-count/running-total summary for this screen, so
  it ships as plain `OrderView[]` with a `TODO(pos/CAP-3, issue #52)`
  comment on `listOpenOrders()` marking where to fold in a summary once
  `OrderLine` lands. `test/pos-open-held-orders.e2e-spec.ts`, 6 tests. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#53.
- **2026-08-25** - POS Cashier & Waiter story 11: device and staff
  attendance status (CAP-11). Pure read story, no new mutation model:
  `GET /pos/v1/outlets/:outletId/attendance` (new
  `src/pos/clock/attendance.controller.ts`/`attendance.service.ts`)
  derives "clocked in" from story 1's real `ClockEvent` rows - the latest
  event per staff member at the outlet being a `clock_in` with no later
  `clock_out`, scoped to today in the outlet's own timezone by reusing
  `clock.util.ts#localDateKey` verbatim rather than reimplementing
  local-day logic. Response also carries a static, honestly-labeled mocked
  printer status (`printerStatus: { status: 'connected', mocked: true }`)
  since this prototype has no real hardware - same honesty discipline as
  the owner dashboard's `hasData`/`message` convention. 9 new e2e tests
  (`test/pos-attendance.e2e-spec.ts`) cover clocked-in/out state,
  same-day-clock-in dedup, cross-outlet isolation, and the mocked field.
  See [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#54.
- **2026-08-25** - POS Cashier & Waiter story 4: order taking with
  modifiers, variants, combos (CAP-3). Extends story 3's `Order` with new
  `OrderLine`/`OrderLineModifier` tables, built against the real, already-
  shipped menu catalogue (tenant-admin/CAP-4's `MenuItem`/`ItemVariant`/
  `ModifierGroup`/`Modifier`). `POST /pos/v1/orders/:orderId/lines`
  (validates every modifier group attached to the item against min/max -
  including a required group with nothing selected, not just an
  over-selected optional one - and snapshots the item's current price plus
  each selected modifier's price at add-time), `PATCH
  /pos/v1/orders/:orderId/lines/:lineId` (quantity and/or modifier
  re-selection, owner-only, only while `open`), `DELETE
  /pos/v1/orders/:orderId/lines/:lineId` (owner-only, only while `open`).
  Adding a line is allowed even after the order is `sent` (AD-14: mutable
  pre-finalisation); editing/removing is not, once sent. `loadOrder`/
  `assertOwner` were lifted out of `OrdersService` into shared top-level
  functions so ownership enforcement is reused, not reimplemented.
  `admin/menu/pricing.ts#resolveCurrentPrice` is reused verbatim (now
  exported through the `admin` barrel) rather than re-picking prices.
  Combos are not built as an order-line type - out of this story's actual
  endpoint contract and screens. 20 new e2e tests
  (`test/pos-order-lines.e2e-spec.ts`), including a direct proof that a
  price change after a line is added never retroactively changes that
  line. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#52.
- **2026-08-25** - POS Cashier & Waiter story 5: group ordering, seats and
  covers (CAP-4). Extends story 4's real `OrderLine` in place - one nullable
  `seatNumber Int?` column (migration `20260825300000_pos_order_line_seat_number`)
  plus an optional `seatNumber` field on both
  `POST /pos/v1/orders/:orderId/lines` and
  `PATCH /pos/v1/orders/:orderId/lines/:lineId` (additive to story 4's DTOs,
  no new endpoint). The gate is entirely application-level, at send time:
  `PATCH /pos/v1/orders/:orderId/status { status: 'sent' }` now rejects `400
  unseated_lines` if any line on the order has no seat assigned, checked in
  `orders.service.ts#assertAllLinesSeated` inside the same transaction as the
  status update, so a failed check never flips the order to `sent`. Orders
  that don't use group ordering are unaffected - the add/edit/remove line
  paths never require a seat number, only the send transition does. 6 new
  e2e tests added to `test/pos-order-lines.e2e-spec.ts` (now 26 total); two
  pre-existing tests there were updated to seat their line before sending,
  since they test story 4's send-freezes-lines rule, not this gate. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#58.
- **2026-08-25** - POS Cashier & Waiter story 8: bill and settle (CAP-7).
  Greenfield `Bill`/`Tender`/`BillNumberCounter` models (AD-14). New
  `src/pos/bills/`: `POST /pos/v1/orders/:orderId/bill` (owner-only,
  snapshots the order's lines into subtotal/tax on an `open` Bill; order
  must be `open` or `sent`), `POST /pos/v1/bills/:id/finalize`
  (validates the tender sum against the bill total, routes a discount above
  a 20%-of-subtotal threshold through the real `platform/manager-auth`
  service per AD-15, reserves a gapless per-outlet bill number via a
  transactional counter row - not a `SEQUENCE`, whose `nextval()` would not
  roll back on a failed attempt - and writes Bill/Tenders/the manager-auth
  audit row/the order's `closed` status in one transaction), `GET
  /pos/v1/bills/:id`. Split types (seat/item/N-way/amount/percent) are
  implemented as "finalise against an arbitrary list of tenders" - N-way and
  amount/percent splits are structurally just multiple `Tender` rows;
  per-seat/per-item splits are left to the web client to compute (story 5's
  `OrderLine.seatNumber` exists by the time this story rebased onto it, but
  this endpoint deliberately doesn't validate a split's tender amounts
  against seat assignment - SPEC treats that grouping as a web-side concern,
  and validating it here would mean re-deriving a per-seat subtotal this
  module has no other use for). No per-item/tenant tax-rate field exists
  anywhere in the schema, so a flat, clearly-commented 5% placeholder is
  applied pending a real tax-configuration story. Also completes a TODO
  CAP-10 left behind: `ShiftsService.closeShift()`'s expected-amount formula
  now folds in real cash-tender bill totals, not just float minus
  paid-outs/bank-drops. 12 new e2e tests (`test/pos-bills.e2e-spec.ts`) plus
  2 more added to `test/shift-cash-management.e2e-spec.ts` for the
  expected-amount formula. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#59.
- **2026-08-25** - POS Cashier & Waiter story 10: refunds and adjustments
  (CAP-9). Greenfield `CreditNote`/`CreditNoteLine` models (AD-14 - the
  third insert-only money-path table pair after `Bill`/`Tender`), extending
  `src/pos/bills/` (no new module): `POST /pos/v1/bills/:id/refund`
  `{ managerPin, reason, lines?: [{ orderLineId, quantity }] }` - `lines`
  omitted refunds every order line's full remaining quantity. `409
  bill_not_finalized` against a still-open bill. Unconditionally gated by
  the real `platform/manager-auth` service's `'refund'` action (same
  `authorize()`/`recordApproval()` call shape story 8's discount gate
  already uses), never mutates the original `Bill` (no `UPDATE` against
  `bills`/`tenders` anywhere in `refund()`). Itemizes against `OrderLine`,
  not a `Bill` line - `Bill` stores only whole-bill aggregates, no lines of
  its own, so `CreditNoteLine` snapshots each refunded `OrderLine`'s real
  `unitPriceMinor`+modifiers and `quantity`, with an over-refund guard
  summing prior credit notes per line. Tax is reversed at the exact same
  `TAX_RATE_PLACEHOLDER_PERCENT` story 8 computed the original bill's tax
  with (now exported from `bills.service.ts`, not re-derived). 7 new e2e
  tests (`test/pos-refunds.e2e-spec.ts`): full refund, partial refund with
  proportional tax, over-refund rejection, missing/wrong manager PIN,
  missing reason, refund-against-open-bill rejection, cross-tenant
  isolation. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#63.
- **2026-08-25** - POS Cashier & Waiter story 7: QSR counter and token mode
  (CAP-6). A composition story, not a parallel implementation: the only
  genuine gap was that no endpoint existed to create a `tableId: null`
  (counter) order, since story 3's `openOrClaimTable` always requires a
  table. New `POST /pos/v1/outlets/:outletId/counter-orders` (extends the
  existing `src/pos/orders/` module) creates that order and reserves the
  next gapless-per-outlet token number in one transaction, via a new
  `TokenNumberCounter` model following the exact reserve-then-commit
  convention story 8's `BillNumberCounter` established (a separate table
  rather than a second column, since token numbers and bill numbers are
  reserved at different moments by different services). New nullable
  `orders.token_number` column, returned on every `OrderView`. The rest of
  the flow - add lines, create a bill, finalise it - reuses story 4's and
  story 8's real endpoints completely unchanged; `bills.service.ts`'s
  `createBill` already accepted an `open` (not just `sent`) order in
  anticipation of exactly this story, so a counter order never needs a
  kitchen-fire hop. 6 new e2e tests
  (`test/pos-counter-orders.e2e-spec.ts`), including gapless-numbering and
  survives-a-failed-attempt cases mirroring story 8's bill-numbering test,
  plus a full create -> add-lines -> bill -> finalize sequence against the
  real endpoints. See
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md).
  Issue AusPosRest/restiq-backend#62.
- **2026-08-29** - Customer QR Self-Order story 1: guest realm, table
  session, and QR entry gate (CAP-1). The fifth disjoint auth realm
  (AD-17, `aud:"guest"`, `GUEST_JWT_SECRET`) - the first whose principal is
  not staff, minted only from a `TableSession` join. Greenfield
  `TableSession`/`Guest` models (one open session per table via a partial
  unique index, same convention as `shifts_one_open_per_outlet`); the
  4-digit `sessionPin` is deliberately plain-stored and rate-limited, not
  argon2-hashed (SPEC/AD-17: it gates a shared cart, not money or an
  account). New public `POST /guest/v1/sessions` (start),
  `POST /guest/v1/sessions/join` (PIN join, rate-limited 5/30s), and
  `GET /guest/v1/outlets/:outletId/availability`, plus authenticated
  `GET /guest/v1/session` and staff-side
  `POST /pos/v1/tables/:tableId/close-session`. The `qr_ordering`
  `OutletCapability` gate is enforced server-side on every entry point, not
  just the availability check. A new `guest_entry_read` RLS policy on
  `outlets`/`dining_tables` lets a pre-auth guest request resolve its
  tenant from a scanned outlet+table pair, mirroring
  `owner_invites`' `invite_accept_read`. 22 new e2e tests
  (`test/guest-session.e2e-spec.ts`, `test/guest-realm.e2e-spec.ts`, plus
  RLS coverage added to `test/rls.e2e-spec.ts`) and 5 new unit tests
  (`src/guest/sessions/join-lockout.spec.ts`). See
  [wiki/features/qr-self-order.md](../features/qr-self-order.md). Issue
  AusPosRest/restiq-backend#68.
- **2026-08-29** - Kitchen Display story 1: ticket domain, item-station
  routing, and fire-on-send (CAP-1, the KDS surface's keystone story - every
  other KDS screen story and two QR self-order stories consume this API).
  Nullable `menu_items.station_id` (additive, `PATCH
  /admin/v1/menu/items/:itemId/station`, one schema owner). Greenfield
  `Ticket`/`TicketLine`/`TicketEvent` tables (insert-only past bump, RLS per
  AD-5). The `open -> sent` transition
  (`pos/orders/orders.service.ts#updateStatus`) now fires real tickets in
  the same transaction, grouped per resolved station (unrouted items fall
  back to the outlet's oldest station, or a synthetic "unrouted" grouping
  if the outlet has none); adding a line to an already-"sent" order
  (`pos/order-lines/order-lines.service.ts#addLine`) appends an ADD-ON
  batch to the target station's existing queued ticket, or opens a new one
  only if the prior ticket there was already bumped. New `src/kitchen`
  module (`KitchenTicketsService`, exported for pos/orders and
  pos/order-lines to call into) serving `bump`/`recall`/`refire` actions
  (no actor attribution, shared station screen) and the station-queue/expo/
  bumped/all-day-summary/stations-picker reads, all under `/kitchen/v1`,
  riding the existing `pos` realm unchanged (`PosAuthGuard`'s route match
  extended to `^/(pos|kitchen)(/|$)`). 13 new e2e tests
  (`test/kitchen.e2e-spec.ts`): two-station fire, unrouted-item fallback
  (both with and without an outlet default station), add-on batching on
  re-fire, new-ticket-after-bump edge, bump/recall/conflict cases, expo
  consolidation with partial-bump waiting-on, all-day summary decrementing
  on bump, and cross-tenant isolation. Every existing e2e spec's `wipe()`
  helper updated to clear the three new tables. See
  [wiki/features/kitchen-display.md](../features/kitchen-display.md). Issue
  AusPosRest/restiq-backend#67.
- **2026-08-29** - Customer QR Self-Order story 2: guest menu browse and
  item detail (CAP-2). A read-only projection of the real catalogue
  (`admin/menu`'s `MenuCategory`/`MenuItem`/`ItemVariant`/`ModifierGroup`/
  `Modifier`/`Allergen`/`ItemOutletOverride`) scoped to the authenticated
  guest's own outlet - never a copy. New `GET /guest/v1/menu` (categories
  with items, each carrying its current `qr`-channel price resolved through
  `admin/menu/pricing`'s `resolveCurrentPrice`, reused verbatim through the
  admin barrel; variants and modifier groups with min/max; allergen tags;
  an `available` flag combining the item's tenant-wide 86 toggle with any
  per-outlet `ItemOutletOverride`, override winning when present) and
  `GET /guest/v1/menu/items/:itemId` for the Q4 item-detail screen. Both
  routes require a guest token - no capability check needed beyond the
  existing guard, since the outlet is read from the principal, not a
  client-supplied param. **Schema gap found and reported, not
  fabricated:** the SPEC and stories.yaml both want photos, veg/non-veg
  markers, and bilingual (Hindi) names on menu items; `MenuItem` has none
  of those columns today, so this projection omits them rather than
  inventing data - flagged in
  [wiki/features/qr-self-order.md](../features/qr-self-order.md) for a
  future menu-schema story. 9 new e2e tests
  (`test/guest-menu.e2e-spec.ts`): outlet scoping, price resolution
  matching the real resolver (including an outlet-specific override
  beating the unscoped price), a tenant-wide 86'd item included but marked
  unavailable, a per-outlet override marking an item unavailable at one
  outlet only, cross-tenant isolation, item-detail read, and guest-token
  enforcement (401 without one, 401 for a pos-realm token - the existing
  `guest-realm.e2e-spec.ts` already proves this generally for every
  `/guest` route). Issue AusPosRest/restiq-backend#71.
- **2026-08-29** - qr-self-order story 3: shared group cart (CAP-3). New
  `src/guest/cart/` (`CartService`/`CartController`) under `/guest/v1/cart`
  - `GET` (combined table cart grouped by guest with per-guest and combined
  totals, resolved prices), `POST /lines` (add), `PATCH /lines/:id`
  (quantity/modifiers, owning guest only), `DELETE /lines/:id` (owning
  guest only). Greenfield `CartLine`/`CartLineModifier` tables (session
  state, not an `Order` - see the feature doc) with RLS (AD-5). Item
  availability (tenant-wide 86 + per-outlet override) and modifier min/max
  validation mirror `pos/orders/order-lines.service.ts`'s real rules
  exactly. 16 new e2e tests (`test/guest-cart.e2e-spec.ts`): cross-guest
  attribution and visibility, per-guest/combined totals, ownership
  enforcement (403 on editing/removing another guest's line), min/max and
  86'd-item rejection, closed-session 410s, and cross-tenant/cross-realm
  isolation. `test/rls.e2e-spec.ts` gained a `cart_lines`/
  `cart_line_modifiers` probe. Every existing e2e spec's `wipe()` helper
  updated to clear the two new tables. See
  [wiki/features/qr-self-order.md](../features/qr-self-order.md). Issue
  AusPosRest/restiq-backend#72.
- **2026-08-29** - qr-self-order story 4: order placement into the real
  pipeline (CAP-4). New `POST /guest/v1/orders` (`src/guest/orders/`)
  atomically converts the caller's session cart into a real `Order`/
  `OrderLine` set - source `'qr'`, `sessionId` set, no staff owner (see
  below) - and fires it through the exact same open->sent kitchen
  transition (`KitchenTicketsService.fireOnSend`, AD-16) a staff order uses,
  in the same transaction, so real `Ticket`/`TicketLine` rows exist,
  correctly station-routed. The cart is deleted on success. Purely additive
  schema (no new tables): `Order` gains `source` (`OrderSource` enum,
  default `pos`) and nullable `sessionId`; `Order.ownerId` and
  `OrderLine.addedByStaffId` both became **nullable** (a guest order/line
  has no staff owner/adder - a documented decision against faking one, see
  the feature doc); `OrderLine` gains nullable `guestId`/`guestName`,
  carried straight from `CartLine`. `pos/orders`'s `assertOwner` now treats
  a null `ownerId` as unclaimed (any staff may act, or take it over via the
  existing `transfer()` action); `OrderView`/`OrderLineView` and kitchen's
  `TicketLineView` extended additively with the new fields so POS and KDS
  render guest orders/tickets with their labels, zero other special-casing
  (AD-18). Each distinct guest in the session is auto-assigned a seat
  number by join order so the existing all-lines-seated fire gate is
  satisfied by construction - documented in `guest/orders/orders.service.ts`
  rather than re-deriving or bypassing that gate. 7 new e2e tests
  (`test/guest-order-placement.e2e-spec.ts`): guest-attributed lines with
  correct station-routed tickets, the order appearing in the POS
  open-orders list, cart consumption, empty-cart rejection, closed-session
  410, and cross-tenant isolation. See
  [wiki/features/qr-self-order.md](../features/qr-self-order.md). Issue
  AusPosRest/restiq-backend#77.
- **2026-08-29** - qr-self-order story 5: guest checkout and split payment,
  simulated (CAP-5), the last money-path story of the build. New
  `src/guest/bills/` (`GuestBillsService`/`GuestBillsController`):
  `POST /guest/v1/orders/:orderId/bill` (creates the REAL Bill and splits it
  into one `BillShare` per distinct guest, proportional to their own
  `OrderLine` attribution, summing exactly to the total), `GET .../bill`
  (bill + live share breakdown), `POST /guest/v1/bills/:id/shares/:guestId/pay`
  `{ simulatedOutcome: 'success' | 'failure', payerPhone? }` (the
  demo-marked simulated payment step - a failure writes nothing at all, so
  UJ-5's invariant holds structurally: every other guest's paid share is
  untouched and only the failed one stays outstanding), and
  `POST /guest/v1/bills/:id/pay-all` (one-payment mode, one Tender for the
  total). The bill finalises itself - same gapless reserve-then-commit
  numbering pos/bills' staff finalize uses - exactly when the last
  outstanding share is paid, and the table session settles
  (`status: 'settled'`) in the same transaction. Bill creation/finalisation
  is ONE implementation, not two: extracted into framework-free
  `src/pos/bills/bill-core.ts` and exposed through a second, narrowly-scoped
  barrel (`src/pos/bills/index.ts`, exporting only that core - never
  `BillsService`); both the staff path (`pos/bills/bills.service.ts`,
  refactored to call the same functions) and the guest path call into it, as
  plain functions rather than a NestJS-injected provider, specifically to
  avoid the `pos`<->`guest` module DI cycle CAP-4's placement story already
  reasoned through. `eslint.config.mjs` gained one boundary exception
  (`!**/pos/bills`) for this scoped barrel. Schema: `Bill.createdByStaffId`
  became nullable (a guest bill has no staff creator, same posture as
  `Order.ownerId`'s story-4 change), and a new greenfield `BillShare` table
  (migration `20260829080000_guest_checkout_split_payment`) tracks the
  per-guest breakdown - deliberately no `'failed'` status, since a failed
  simulated payment has zero effect on any row. 9 new e2e tests
  (`test/guest-checkout.e2e-spec.ts`): the UJ-5 five-guest scenario end to
  end (four successes, one simulated failure leaving exactly that share
  outstanding with the other four Tenders intact, a rejected double-pay, a
  successful retry that finalises the bill/closes the order/settles the
  session with a gapless bill number), one-payment mode (success, simulated
  failure, and refusing to run over a bill with a share already paid
  individually), a staff close 410ing bill creation, missing-token 401s, and
  cross-tenant isolation. Every existing e2e spec's `wipe()` helper updated
  for the new `bill_shares` table. See
  [wiki/features/qr-self-order.md](../features/qr-self-order.md). Issue
  AusPosRest/restiq-backend#80.
- **2026-08-29** - qr-self-order story 6: order status tracking (CAP-6). New
  `GET /guest/v1/orders/:orderId/status` and `GET /guest/v1/session/orders`
  (`src/guest/orders/`), pure reads - no schema change. Server-derives a
  `placed`/`accepted`/`preparing`/`ready` stepper off the real `Order`/
  `Ticket` rows: `placed` at `Order.createdAt`; `accepted` and `preparing`
  both reach at the earliest fired `Ticket.firedAt` (the real ticket model
  has no separate "started cooking" state, so this collapse is documented
  rather than papered over with an invented time-in-queue heuristic);
  `ready` only once every one of the order's tickets is bumped, at the
  latest `bumpedAt`. The top-level `step` reports the furthest reached stage
  (`'preparing'` once tickets exist but aren't all bumped, `'ready'` once
  they are) - never a state the ticket data doesn't support, per CAP-6's
  success criterion. Both endpoints require the caller's session to be
  active (410 `session_closed`) and the order to belong to that same
  session, not merely the same tenant (404 `not_found` otherwise, whether
  the order doesn't exist, belongs to another tenant, or another session -
  one response for all three). 7 new e2e tests
  (`test/guest-order-status.e2e-spec.ts`): the full lifecycle walk (placed ->
  preparing on fire -> still preparing with one of two tickets bumped ->
  ready once both are, with a real `reachedAt`), the session-orders list
  across two orders on the same table (closing the first to satisfy
  `orders_one_active_per_table` before placing the second), another
  session's order id 404s, a nonexistent order id 404s, a closed session
  410s both endpoints, no token 401s, and cross-tenant isolation. See
  [wiki/features/qr-self-order.md](../features/qr-self-order.md) for the
  full step-mapping write-up. Issue AusPosRest/restiq-backend#81.
- **2026-09-02** - Public device-side enrolment endpoint (device realm,
  AD-12/AD-13). New `POST /device/v1/enroll` (`src/device/`, unauthenticated
  by construction - no guard matches the `/device` prefix) lets a device
  redeem its own one-time enrolment code directly, as the product intends;
  the existing `POST /ops/v1/devices/enroll` still requires an operator
  token and is unchanged for the internal console. Both now call
  `DevicesService.enrollWithActor()`, extracted from the ops-only `enroll()`
  (same one-time-use/expiry/code checks, same `Device` row shape) so the
  two callers can't drift - they differ only in the `audit_events` actor: an
  ops operator's `{ id, email }`, or `{ actorId: null, actorEmail:
  'device:<hardwareKeyFingerprint prefix>' }` for a device with no operator
  identity. No schema change. **Known risk:** enrolment codes are short and
  this route has no application-level rate limiting - no throttling
  package/pattern exists elsewhere in the repo to reuse, so none was
  invented here; noted in the PR as an infra-level (reverse proxy/WAF)
  followup rather than shipped ad hoc. 7 new e2e tests
  (`test/device-enroll.e2e-spec.ts`): the public happy path (audited with a
  device actor), `code_invalid`/`code_expired`/`code_already_used`, that any
  `Authorization` header sent is simply ignored on this route, body
  validation, and that the ops-realm enroll endpoint keeps working
  unchanged. See
  [wiki/features/platform-console.md](../features/platform-console.md).
  Issue AusPosRest/restiq-backend#89.
- **2026-09-02** - CAP-5 floor plan: `DELETE
  /admin/v1/outlets/:outletId/floor-plan/floors/:floorId` (204, or 409
  `floor_has_tables` if the floor still has any dining tables - deletion
  never cascades to tables, so an owner must move or delete them first).
  Mirrors `deleteTable`'s RLS/tenant scoping and owner auth exactly; no
  audit event, matching `deleteTable`'s precedent. 4 new e2e tests in
  `test/floor-plan.e2e-spec.ts`: deleting an empty floor, refusing a floor
  with a table (floor and table both survive), a nonexistent floor 404s,
  and cross-tenant isolation. See
  [wiki/features/tenant-admin.md](../features/tenant-admin.md). Issue
  AusPosRest/restiq-backend#92.
- **2026-09-02** - Rate-limit the public `POST /device/v1/enroll` endpoint
  (closes the known risk noted in issue #89): new `EnrollRateLimitGuard`
  (`src/device/enroll/enroll-rate-limit.guard.ts`), applied only to that
  route, throttles it to `ENROLL_RATE_LIMIT_ATTEMPTS` (10) attempts per
  `ENROLL_RATE_LIMIT_WINDOW_MS` (5 minutes) per client IP, returning `429
  rate_limited` in the standard `{ error: { code, message } }` shape once
  exceeded. No `@nestjs/throttler`-style package exists in this repo, so
  this is a small hand-rolled `CanActivate` (an in-memory
  `Map<ip, { count, windowStart }>`, lazily evicting an IP's expired window
  on its next lookup) rather than a new dependency - single-process by
  design, with a Redis followup called out in the file header if this API
  ever runs multi-instance. Client IP is read from `X-Forwarded-For`
  (first entry) falling back to `req.ip`. 3 new e2e tests in
  `test/device-enroll.e2e-spec.ts`: 10 bad-code attempts succeed as
  `400 code_invalid` and the 11th is `429 rate_limited`, a different
  client IP is unaffected once one is limited, and a valid code still
  redeems within the limit. See
  [wiki/features/platform-console.md](../features/platform-console.md).
  Issue AusPosRest/restiq-backend#95.
