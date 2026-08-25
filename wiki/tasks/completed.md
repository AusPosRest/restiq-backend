# Completed

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
