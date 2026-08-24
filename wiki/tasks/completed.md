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
