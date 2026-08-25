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
