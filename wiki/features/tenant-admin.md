# Tenant Admin (Owner Web Console) - backend

Backend for the `/admin` realm (AD-10): the owner-facing console that follows
Platform Console. See `restiq-design/docs/specs/spec-tenant-admin/SPEC.md`
for the full capability set (CAP-1..10); this doc tracks what's actually
built here, story by story.

## CAP-1 - Owner invite & account setup

- **Intent:** an invited owner accepts their invite, sets credentials, and
  lands in the go-live checklist with no extra login step.
- **Built:** `POST /admin/v1/auth/accept-invite` (`src/admin/auth.controller.ts`,
  `src/admin/auth.service.ts`). Validates the invite token created by Platform
  Console's onboarding wizard (`owner_invites`, `src/ops/tenants/tenants.service.ts`)
  against three distinct outcomes: unknown token (`invite_invalid`, 400),
  expired (`invite_expired`, 400), already used (`invite_already_used`, 409).
  On success: creates/activates an `owner_users` row, marks the invite used,
  seeds `checklist_progress`, writes an `audit_events` row, and returns an
  `aud:"admin"` JWT (`ADMIN_JWT_SECRET`, `src/platform/admin-jwt.ts`) - the
  owner is signed in immediately, no separate login call.
- **Realm:** `/admin/*` is a third disjoint auth realm alongside `/ops` (AD-3)
  and the control plane, per AD-10. `AdminAuthGuard` (`src/platform/admin-auth.guard.ts`)
  accepts only `aud:"admin"` tokens signed with `ADMIN_JWT_SECRET`; an
  `aud:"ops"` token is rejected even if (hypothetically) signed with the
  admin secret, and vice versa - proven in `test/admin-realm.e2e-spec.ts`.

## CAP-2 - Go-Live Checklist

- **Intent:** a new tenant sees per-step completion for outlet details, floor
  plan, menu import, devices, and staff, and can go live once every step is
  done.
- **Built:**
  - `GET /admin/v1/checklist` - per-step `{ step, completed, completedAt }`,
    plus `canGoLive` and the tenant's current status.
  - `PATCH /admin/v1/checklist/:step` - `{ completed: boolean }`, sets/clears
    that step's timestamp.
  - `POST /admin/v1/checklist/go-live` - 409 `checklist_incomplete` (with a
    `missingSteps` array) if any of the five steps is incomplete; otherwise
    flips the region-plane `tenants.status` from `provisioning` to `active`
    (AD-9: state lives region-side, never in the control-plane registry) and
    audits `tenant.went_live`. Idempotent: calling it again once live just
    re-confirms `active`, no second audit row.
  - Backing table: `checklist_progress`, one row per tenant, a nullable
    timestamp column per step (`src/admin/checklist/checklist.service.ts`).
- **Integration points for stories 3, 5, 6, 7:** none of the five steps is
  derived from another table today - every step is a plain PATCH target
  (or, per `menu_import` below, an internal service call). When a story
  ships the real feature behind a step, it should update
  `checklist_progress` from its own write path instead of leaving the owner
  to tick it manually:
  - `outlet_details` - the outlet-details editing story.
  - `floor_plan` - **done (CAP-5)** - `FloorPlanService.createTable` calls
    `ChecklistService.updateStep` when it creates an outlet's first table.
  - `menu_import` - **done (CAP-3, this story)** - `MenuImportService.commit`
    calls `ChecklistService.updateStep` directly on a successful commit.
  - `devices` - **done (CAP-6)** - the shared `DevicesService.enroll()`
    (`src/ops/devices/devices.service.ts`) flips it directly, in the same
    transaction as the device row, on the tenant's first device.
  - `staff` - **done (CAP-7)** - `StaffService.create` flips it directly, in
    the same transaction as the staff row, on the tenant's first staff
    member.

## CAP-3 - AI-assisted menu import

- **Intent:** an owner imports a menu from a spreadsheet, photo, or PDF; the
  system drafts structured items for human review before anything commits -
  no imported item reaches the live menu without passing through review.
- **Built** (`src/admin/menu-import/`):
  - `POST /admin/v1/menu-import/upload` - accepts a `multipart/form-data`
    file (field `file`, 10 MB cap). CSV and XLSX are actually parsed into
    structured rows (`extraction.ts`); a header row is matched against known
    aliases for name/short name/category/price. Image and PDF sources return
    a fixed, lower-confidence sample draft - see "AI stub" below. Returns a
    draft: `{ importId, status: "draft", sourceType, fileName, items: [{ id,
    name, shortName, category, priceMinor, currency, confidence: { name,
    shortName, category, price, overall } }] }`. Nothing is written to
    `menu_categories`/`menu_items`/`item_prices` at this point.
  - `PATCH /admin/v1/menu-import/:importId` - `{ items: [{ id, name?,
    shortName?, category?, priceMinor?, currency? }] }`. Edits the draft's
    JSON payload in place (still not the live catalogue); any field touched
    by an edit is bumped to confidence `1` (human-reviewed), and `overall`
    is recomputed as the mean of the four field confidences. 404 if the
    draft doesn't exist (or belongs to another tenant), 400 for an unknown
    item id, 409 if the draft is already committed.
  - `POST /admin/v1/menu-import/:importId/commit` - one transaction:
    resolves each draft item's category by name (case-insensitive; reuses
    an existing `menu_categories` row for the tenant if one matches, else
    creates it), creates the `menu_items` row, creates its first
    `item_prices` row (AD-11: insert, never update), writes an
    `audit_events` row (`menu.imported`), and marks the draft `committed`.
    A duplicate item name within one category throws (DB unique constraint,
    mapped to 409 `conflict`) and rolls back everything from that commit -
    proven directly, not just asserted, in
    `test/menu-import.e2e-spec.ts`. On success, calls
    `ChecklistService.updateStep(tenantId, 'menu_import', true)` directly
    (the same internal service CAP-2 exposes at
    `PATCH /admin/v1/checklist/menu_import` - no HTTP self-call, no
    reimplementation). That call is intentionally outside the commit
    transaction: Prisma's interactive transactions don't compose across
    separate `$transaction` calls, and this story's atomicity guarantee is
    scoped to the catalogue write + draft resolution, not the checklist
    flag.
  - Draft storage: `menu_import_drafts`, one row per upload, tenant-scoped
    with RLS `tenant_isolation` + `operator_read` (AD-5). A real table, not
    an in-memory map - survives a reload and works across app instances.
    Status is `draft` -> `committed` (kept for history, not deleted).
- **AI stub (deviation, read before wiring a real model in):** no
  vision/OCR/LLM extraction service exists anywhere in this codebase yet.
  `extraction.ts`'s `scanStub()` returns a fixed 3-item draft with uneven,
  mid-range confidence (0.55-0.72 per field) for any image or PDF upload,
  simulating what a real scan typically gets right (the name) versus wrong
  (price, category). CSV/XLSX extraction is real: actual header/column
  matching, actual values, confidence 1 for present fields, ~0.3-0.5 for
  fields the parser had to default or derive. Swap `scanStub` for a real
  vision-language extraction call later; the `DraftItem[]` shape it returns
  is the only contract downstream code depends on - nothing else in this
  module or its callers needs to change.

## CAP-4 - Menu management

- **Intent:** an owner manages categories, items, variants, modifier groups
  (with min/max rules), combos, allergen/dietary tags, per-outlet overrides,
  per-channel prices, scheduled price changes, and item availability (86).
  Editing a price creates a new version, never mutates the old one; 86 is
  reflected in the same request.
- **Built** (`src/admin/menu/`), all under `/admin/v1/menu`:
  - **Categories** (`categories.controller.ts`/`.service.ts`): `GET /categories`
    (with `itemCount`), `POST /categories`, `PATCH /categories/:id`,
    `DELETE /categories/:id` (409 `category_not_empty` if it still has
    items). Routine content edits - no audit reason (SPEC constraint).
  - **Items** (`items.controller.ts`/`.service.ts`): `GET /items?categoryId=`,
    `GET /items/:id`, `POST /items`, `PATCH /items/:id`. An item's response
    always nests its full `variants`, `modifierGroups` (with their
    `modifiers`), and `allergens` - one shape for list and detail, no
    separate "summary" projection.
    - Variants: `POST /items/:id/variants`, `DELETE /items/:id/variants/:variantId`.
    - Modifier-group / allergen attachment is replace-the-set, not
      add/remove: `PUT /items/:id/modifier-groups { modifierGroupIds: [] }`,
      `PUT /items/:id/allergens { allergenIds: [] }`.
    - 86 toggle: `PATCH /items/:id/availability { available }` - immediate,
      tenant-wide, not versioned, not audited (not in the SPEC's named
      security-relevant list).
    - Per-outlet availability override: `PUT /items/:id/outlets/:outletId/availability
      { available }` (upsert), `DELETE` (clear override, reverts to the
      item's tenant-wide `available`). No override row = tenant-wide applies.
  - **Modifier groups** (`modifier-groups.controller.ts`/`.service.ts`):
    tenant-scoped, reusable catalog. `GET/POST /modifier-groups`,
    `PATCH /modifier-groups/:id`, `POST /modifier-groups/:id/modifiers`.
    `minSelections`/`maxSelections` are validated at write time (0 <= min <=
    max) on the *resolved* final values, so a partial PATCH can't leave the
    row invalid even transiently.
  - **Allergens** (`allergens.controller.ts`/`.service.ts`): tenant-scoped
    tag catalog, moved here from CAP-3 per the spec amendment (unreliable
    from OCR/CSV). `GET/POST /allergens`; attach to an item via the item's
    `PUT /items/:id/allergens` above.
  - **Combos** (`combos.controller.ts`/`.service.ts`): a flat-priced bundle
    of existing items. `GET/POST /combos`. Not versioned (AD-11 binds
    `item_prices`, not combos) - a routine content edit like the rest of
    this module's CRUD.
  - **Prices** (`prices.service.ts`, routed from `items.controller.ts`):
    `POST /items/:id/prices` - the ONE place `item_prices` is ever written
    from this module (AD-11): always an INSERT, the targeted row (by
    `variantId`/`channel`/`outletId`) is never UPDATEd. Price change is one
    of the SPEC's named security-relevant actions, so `reason` is required
    and an `audit_events` row (`menu.item.price_changed`) is written in the
    same transaction. `effectiveAt` is optional - omitted or past means
    immediate, future schedules it.
    `GET /items/:id/price?channel=&variantId=&outletId=` - the load-bearing
    current-price read (`menu/pricing.ts`'s `resolveCurrentPrice`/
    `pickCurrentPrice`, unit-tested in `pricing.spec.ts`): the most recent
    `item_prices` row with `effectiveAt <= now`, most-specific match first
    (exact outlet beats unscoped outlet; exact channel beats unscoped
    channel; outlet specificity is checked before channel specificity).
    404 `no_current_price` if nothing is eligible yet.

## CAP-8 - Owner dashboard

- **Intent:** an owner sees live sales, margin, labour, and waste per
  outlet, with cross-outlet comparison - every figure carrying an honest
  freshness indicator, never a silently outdated number presented as
  current.
- **No real sales data yet - this is a deliberate decision, not an
  oversight.** RESTIQ's POS Core Loop (the surface that actually takes
  orders and would generate `Order`/`Bill`/`Payment` rows) has not been
  built anywhere in this codebase yet - only Platform Console and Tenant
  Admin exist so far. There is nothing to aggregate live sales, margin,
  labour cost, or waste from. Rather than fabricate numbers or add a
  shadow orders table to make the screen look populated (which would show
  a real owner figures that correspond to nothing), or silently omit the
  fields, `GET /admin/v1/dashboard` returns each of `sales`/`margin`/
  `labourCost`/`waste` as an explicit `{ amountMinor: 0, currency,
  hasData: false, message }` - a stronger form of the SPEC's honesty
  requirement than a "stale" badge, since no number is presented as
  current at all. Wire real aggregation in when the POS Core Loop ships an
  Order/Bill/Payment model; the shape (`hasData`, `message`) is designed
  to flip to real values without a breaking change.
- **Built** (`src/admin/dashboard/`): `GET /admin/v1/dashboard` ->
  `{ asOf, tenant: { outletCount, staffCount, menuItemCount, deviceCount,
  status, goLiveAt }, outlets: [{ outletId, outletName, deviceCount,
  sales, margin, labourCost, waste }] }`.
  - `asOf` is `new Date().toISOString()` at request time - a real
    timestamp reflecting when the aggregate was actually computed (the
    SPEC's freshness success criterion), not a cached or stale value.
  - **Per-outlet `deviceCount`** is real: `devices` grouped by `outletId`,
    `status: 'active'` only (a revoked device is no longer in service).
  - **`staffCount` and `menuItemCount` are reported only in the tenant
    rollup, never split per outlet** - deliberate, not an omission.
    `staff_users` has no `outletId` column at all (see CAP-7 above: no
    outlet-scoped staff/access model exists in this codebase), so there is
    no real per-outlet split to report; `menu_items` belong to the
    tenant's one shared catalog (CAP-4: only per-item *availability* is
    outlet-overridable, not the item's existence), so its count is
    likewise a tenant-wide fact, not an outlet one. Repeating the same
    tenant total on every outlet row would look like real per-outlet data
    when it isn't - the honest choice was to put both counts where they're
    actually true: the rollup. This deviates from a per-outlet
    `staffCount`/`menuItemCount` shape that might otherwise be assumed;
    flagged here so it isn't mistaken for a bug later.
  - `menuItemCount` counts `MenuItem` rows with `available: true` (the 86
    toggle) - an item turned off tenant-wide is excluded, same as it would
    be from the live menu.
  - `tenant.status` / `tenant.goLiveAt` reuse CAP-2's data: `status` is the
    region-plane `tenants.status` (`provisioning`/`active`); `goLiveAt` is
    the `occurredAt` of that tenant's `tenant.went_live` audit event (the
    row CAP-2's `goLive()` writes on the provisioning -> active
    transition) - `null` before go-live. There is no dedicated
    `goLiveAt` column; deriving it from the existing audit trail avoids
    adding one for a value that's already recorded elsewhere.
  - Currency per metric is derived from `tenant.country` the same way
    `menu-import.service.ts` and `tenants.service.ts` already do (`IN` ->
    `INR`, else `AUD`) - no new currency-resolution logic.
  - Every query scoped through `owner.tenantId` inside a
    `SELECT set_config('app.tenant_id', ...)` transaction (AD-5), same
    pattern as every other admin service.

## CAP-9 - Reports catalogue

- **Intent:** an owner browses and exports Sales, Financial (GST/BAS-ready),
  Menu Engineering, Operations, Inventory, and Labour reports, and can pick
  an accounting tool to export summarised journals to.
- **No real transactional reports yet - this is a deliberate decision, not
  an oversight.** Same reality as CAP-8's dashboard: RESTIQ's POS Core Loop
  (the surface that would generate `Order`/`Bill`/`Payment` rows) hasn't
  been built, and no `Document`/`Z-report` immutable model exists either,
  despite the SPEC's success criterion referencing one. Sales, Financial
  (GST/BAS), Menu Engineering (by volume), Operations, Inventory, and
  Labour-cost reports all ultimately depend on that transactional data.
  Rather than fabricate report content or invent a shadow transactional
  model to populate the screen, every one of those report types is listed
  in the catalogue honestly, with `hasData: false`, the message "Available
  once POS Core Loop is live", and `exportFormats: []` - nothing to export
  yet. Wire real generation in when the POS Core Loop ships an
  Order/Bill/Payment/Document model; the catalogue shape (`hasData`,
  `message`, `exportFormats`) is designed to flip to real values without a
  breaking change.
- **Two report types ARE real today**, backed by tables that already exist
  and are already live-written by other capabilities:
  - **Menu Catalogue** (`hasData: true`) - CAP-4's `menu_categories` /
    `menu_items` / `item_prices`.
  - **Staff Roster** (`hasData: true`) - CAP-7's `staff_users` / `roles`.
- **Built** (`src/admin/reports/`):
  - `GET /admin/v1/reports` -> `ReportCatalogueEntry[]`, each
    `{ key, name, category: "sales"|"financial"|"menu"|"operations"|
    "inventory"|"labour", hasData, message, exportFormats }`. Static
    per-request list (no DB read) - the auth guard already requires a valid
    owner session to reach it, and there's nothing tenant-specific about
    which report *types* exist.
  - `GET /admin/v1/reports/menu-catalogue/export?format=csv` -> a real CSV
    (`category,item,short_name,variant,price,currency,available`) of the
    tenant's live menu. One row per item with no variants, one row per
    variant otherwise. "Current price" reuses CAP-4's own resolution rule
    (`menu/pricing.ts`'s `resolveCurrentPrice`), taken for the `dine_in`
    channel with no outlet override - a report needs one representative
    price per row, not a full channel/outlet matrix. An item/variant with
    no priced row yet exports an empty `price`/`currency` rather than a
    fabricated figure.
  - `GET /admin/v1/reports/staff-roster/export?format=csv` -> a real CSV
    (`name,email,role,pin_status`) of the tenant's current staff, reusing
    `staff.service.ts`'s own `pinStatus()` derivation rather than a second
    copy of the PIN-state logic.
  - Both export endpoints 400 on any `format` other than `csv` (the only
    format either catalogue entry advertises) - a bad or missing format is
    a rejection, not a silent fallback.
  - `GET /admin/v1/reports/export-destinations` -> a static
    `ExportDestinationView[]`, `{ key, name, status: "not_connected" }` for
    Tally, Xero, MYOB, Zoho Books, and QuickBooks. Every destination is
    honestly `"not_connected"` - there is no OAuth/API integration to any
    accounting tool anywhere in this codebase. This endpoint exists so the
    console can render the destination *picker* the SPEC describes without
    pretending a connection exists.
  - Every export scoped through `owner.tenantId` inside a
    `SELECT set_config('app.tenant_id', ...)` transaction (AD-5), same
    pattern as every other admin service.

## CAP-10 - Branding & capabilities

- **Intent:** an owner sets receipt/UI branding tokens and toggles
  per-outlet capabilities (QR ordering, kiosk, token queue, etc.) driven by
  restaurant type - a toggle takes effect without any client redeploy;
  branding tokens preview live before saving.
- **Built:**
  - `GET /admin/v1/outlets` (`src/admin/outlets/`) - lists the signed-in
    tenant's outlets: `[{ id, name, address, type, timezone }]`, ordered by
    `createdAt`, soft-deleted (`deletedAt`) outlets excluded. Reads
    `outlets`, the table Platform Console's onboarding wizard (story 2 of
    that pipeline) already creates - no new columns, this is the first
    Tenant Admin read of that table. This is also the outlet-switcher
    endpoint story 3's web half needs; there is no `city` field on the real
    table (it has `address`, `type`, `timezone` instead), so the view
    reflects the actual schema rather than the field names guessed at
    kickoff.
  - `GET /admin/v1/branding` / `PUT /admin/v1/branding`
    (`src/admin/branding/`) - reads/writes the tenant's existing
    `branding_tokens` JSON column (added when Platform Console's onboarding
    wizard provisions a tenant, for guest-facing surfaces) rather than a new
    table - Tenant Admin becomes a second reader/writer of the same flat
    token map, not a competing store. Shape:
    `{ primaryColor, secondaryColor, accentColor, surfaceColor, font,
    cornerRadiusPx, logoUrl, receiptHeader, receiptFooter }`, all nullable
    until saved. `PUT` **merges** the given fields into the stored JSON -
    fields the caller omits keep their current value, so the settings form
    (T10: color tokens, font, corner radius, logo, receipt header/footer)
    can save one edited field without resending the whole set. Colors are
    validated as hex (`#RRGGBB`); no logo *upload* endpoint exists yet - the
    DTO takes a `logoUrl` string, matching every other design-token field;
    wiring actual file upload (Cloudflare R2 per workspace standards) is
    left to whichever story needs it.
  - `GET /admin/v1/outlets/:outletId/capabilities` /
    `PATCH /admin/v1/outlets/:outletId/capabilities/:key`
    (`src/admin/outlets/`) - per-outlet feature switches. `GET` returns only
    the keys with an explicit row (`[{ key, enabled }]`); an absent key means
    "not yet toggled", left for the caller to render as its platform
    default. `PATCH` body `{ enabled: boolean }` upserts one
    `outlet_capabilities` row by `(outletId, key)` and returns it - the
    write and the read-back are the same request/response, so "takes effect
    without a redeploy" is trivially true (no cache, no async propagation).
    `key` is a free-text path segment, not a closed enum - the capability
    catalogue (QR ordering, kiosk, token queue, ...) is expected to grow and
    nothing here needs to know its members.
  - Both endpoint groups scope every query to `owner.tenantId` inside a
    `SELECT set_config('app.tenant_id', ...)` transaction (AD-5), same
    pattern as every other admin service - proven directly with a
    cross-tenant listing test, not just asserted.
  - Routine content edits (SPEC constraint) - no audit reason required for
    branding or capability changes, unlike price changes/role changes/PIN
    revokes.

## CAP-5 - Floor plan & stations

- **Intent:** an owner lays out floors and tables, defines kitchen stations
  with ageing thresholds, and maps printers to stations with a fallback
  printer. A floor plan with overlapping tables is rejected or auto-adjusted
  (SPEC left this as an open question); every station has a printer or an
  explicit "no printer" acknowledgement.
- **Built** (`src/admin/floor-plan/`), all under
  `/admin/v1/outlets/:outletId/floor-plan`:
  - `GET /` - `{ floors: [{ id, outletId, name, sortOrder, tables: [{ id,
    floorId, label, x, y, width, height, shape, seatCapacity }] }], stations:
    [{ id, outletId, name, ageingThresholdMinutes, primaryPrinterId,
    fallbackPrinterId }], printers: [{ id, outletId, name, renderMode }] }` -
    the one read the floor-plan editor screen needs, no separate calls per
    floor/station.
  - `POST /floors { name, sortOrder? }`, `PATCH /floors/:floorId { name?,
    sortOrder? }`, `DELETE /floors/:floorId` (204, or 409 `floor_has_tables`
    if the floor still has any tables - the owner must move or delete them
    first; deletion never cascades to a floor's tables).
  - `POST /tables { floorId, label, x, y, width, height, shape,
    seatCapacity }` (201, or 409 `table_overlap`), `PATCH /tables/:tableId`
    (any subset of the same fields, still overlap-checked against the
    resolved bounds), `DELETE /tables/:tableId` (204). A table's `floorId`
    is fixed at creation - `PATCH` cannot move a table to a different floor
    (not in the designed screen; the tool palette drags within one floor's
    canvas).
  - `POST /printers { name, renderMode }` - `renderMode` is `text` or
    `bitmap`. Minimal by design: this story only needs printers to exist so
    a station can reference one; full printer management (status, enrolment)
    is CAP-6's job per the SPEC, reusing the device fleet backend.
  - `POST /stations { name, ageingThresholdMinutes, primaryPrinterId?,
    fallbackPrinterId?, noPrinterAcknowledged? }` (201, or 400
    `printer_required`), `PATCH /stations/:stationId` (same fields, all
    optional). `primaryPrinterId`/`fallbackPrinterId` are tri-state on
    `PATCH`: omitted leaves the existing value untouched, `null` clears it,
    a uuid sets it - the DTO relies on the field being *present* in the
    JSON body (not just non-undefined) to tell "leave alone" apart from
    "clear."
  - **Overlap policy (SPEC open question, builder's call): reject with 409,
    not auto-adjust.** Auto-adjust needs a placement algorithm (where does
    the server move the table, how far) the design doesn't specify; a
    table silently relocated by the server is a worse mid-edit surprise for
    an owner than an immediate "that spot's taken" the UI can show right
    where they dropped it. Overlap is bounding-box intersection (uniform
    across circle/square/rectangle - the editor is grid-based, not a
    physics simulation) with strict inequality, so two tables may share an
    edge without colliding.
  - **Printer-required gate:** fires whenever a request would leave a
    station's `primaryPrinterId` null - at creation (the default, absent
    value) or at update (an explicit `primaryPrinterId: null`). A `PATCH`
    that never mentions `primaryPrinterId` can't silently arrive at a
    printerless station - it either already had one acknowledged, or the
    check already fired when it didn't.
  - **Checklist integration:** the first table ever created for an outlet
    (which requires a floor to already exist, since `POST /tables` needs a
    `floorId`) calls `ChecklistService.updateStep(tenantId, 'floor_plan',
    true)` - same pattern as CAP-3's commit: outside the write transaction,
    since interactive transactions don't compose and this story's atomicity
    guarantee covers the table write, not the checklist flag.
  - Every endpoint scopes through the owner's `tenantId` inside a
    `SELECT set_config('app.tenant_id', ...)` transaction (AD-5); a floor,
    table, station, or printer belonging to another tenant - or a table/
    printer that exists but belongs to a different outlet than the one in
    the URL - 404s or 400s rather than leaking existence.

## CAP-6 - Devices & printers

- **Intent:** an owner views enrolled devices per outlet, generates
  enrolment codes, and sees printer render-mode/fallback configuration -
  reusing the device/enrolment-code backend built for Platform Console
  (AD-12: one implementation, two callers), scoped down to the owner's own
  tenant. An owner can never see or enrol a device for a tenant they don't
  own.
- **Built** (`src/admin/devices/`), a thin wrapper - it adds no
  enrolment-code or device-fleet logic of its own:
  - `GET /admin/v1/outlets/:outletId/devices` -> `{ devices: [{ id,
    tenantId, outletId, label, type, role, status, enrolledAt, revokedAt,
    tenantName, outletName }], nextCursor, total }`. Calls
    `DevicesService.list()` (`src/ops/devices/devices.service.ts`) with
    `{ tenantId: owner.tenantId, outletId }` - the exact same Prisma query
    Platform Console's fleet/tenant-detail views run, scoped one level
    further. `list()` gained an `outletId` filter for this caller; ops
    callers never pass one, so their behaviour is unchanged.
  - `POST /admin/v1/outlets/:outletId/devices/enrolment-codes` -> `{ code,
    deviceType, expiresAt }` (201). Calls
    `DevicesService.generateCode()` - same 15-minute TTL, same
    `sha256(normalized-code)` hash, same code alphabet as
    `ops/v1/devices/enrolment-codes`
    (`test/admin-devices.e2e-spec.ts` asserts the hash format directly, not
    just the response shape). `tenantId` is always `owner.tenantId` from
    the session - `AdminGenerateCodeDto` has no `tenantId`/`outletId`
    field, unlike the ops-realm DTO which trusts an operator to name any
    tenant.
  - `GET /admin/v1/outlets/:outletId/floor-plan/printers` /
    `PATCH /admin/v1/outlets/:outletId/floor-plan/printers/:printerId`
    (`src/admin/floor-plan/`, story 5's module - not duplicated here).
    `PATCH` body `{ renderMode: "text" | "bitmap" }`: a printer's render
    mode is the only field it owns that this story mutates. Fallback
    routing is `Station.fallbackPrinterId`, already `PATCH`-able via
    `updateStation` since story 5 - no second fallback field was added.
  - **Cross-tenant isolation:** `list()` first checks the outlet belongs to
    `owner.tenantId` (404 otherwise, same pattern as every other admin
    outlet-scoped endpoint); `generateCode()` relies on the shared
    service's own tenant/outlet check (`outlet.findFirst({ id: outletId,
    tenantId })` -> 404) - this is the test that proves AD-12 reuse didn't
    leak scoping, not a second check bolted on top.
  - **Checklist integration:** see CAP-2 above - the flip lives inside the
    shared `enroll()` method itself, not in this module, so it fires
    regardless of which realm's token redeemed the code.
- **Deviation:** `DevicesService.list()` runs under operator RLS context
  (`setOperatorContext`, a cross-tenant read bypass) even when called from
  `/admin` - unchanged from Platform Console's original behaviour, since
  splitting the RLS context by caller would touch the shared service beyond
  a thin wrapper. Safe in practice: the `tenantId` filter is derived from
  the verified JWT, never from client input, so the WHERE clause alone
  prevents cross-tenant leakage even without RLS backing it - but it means
  this one read doesn't get AD-5's RLS defense-in-depth layer the rest of
  `/admin` has. Flagged for a follow-up if a future story wants to close
  that gap.

## CAP-7 - Staff & roles

- **Intent:** an owner manages POS-facing staff, assigns each one of the six
  seeded system roles, and issues or revokes POS PINs - PIN revocation takes
  effect for new sign-ins immediately, and no free-text role is ever
  assignable.
- **Built** (`src/admin/staff/`):
  - `GET /admin/v1/roles` -> `[{ id, name, isSystem }]` for the six roles
    Platform Console's onboarding wizard seeds per tenant on provisioning
    (`SYSTEM_ROLES` in `src/ops/tenants/tenants.service.ts`: Owner, Manager,
    Cashier, Waiter, Kitchen, Accountant). Read-only - v1 has no role-write
    route, per the SPEC's non-goal on free-text/custom roles.
  - `GET /admin/v1/staff` -> `{ staff: StaffView[] }`, scoped to the caller's
    own tenant.
  - `POST /admin/v1/staff` -> `{ name, email?, roleId }` (201). `roleId` is
    checked against `roles` for `{ tenantId: owner.tenantId, isSystem: true
    }` before the row is created - anything else (a random uuid, another
    tenant's role id) is 400 `validation_failed`. The FK on `staff_users.role_id`
    is defense in depth under that same-transaction check, not the
    enforcement itself.
  - `PATCH /admin/v1/staff/:id` -> `{ name?, roleId? }`, same seeded-role
    check when `roleId` is supplied. 404 if the id doesn't belong to the
    caller's tenant.
  - `POST /admin/v1/staff/:id/pin` -> `{ pin }` (201). Generates a random
    4-digit PIN (`node:crypto` `randomInt`), stores only its argon2 hash
    (`pin_hash`), sets `pin_issued_at`, clears `pin_revoked_at` - re-issuing
    always supersedes any prior PIN, revoked or not. The raw PIN is returned
    exactly once, never persisted or logged, same posture as an enrolment
    code.
  - `POST /admin/v1/staff/:id/revoke-pin` -> `{ reason }` -> updated
    `StaffView` (200). `reason` is required (400 without one); revocation
    sets `pin_revoked_at` and writes an `audit_events` row
    (`staff.pin_revoked`, actor + reason) in the same transaction, per AD-6
    - PIN revoke is destructive and security-relevant. 409 if the staff
    member has no PIN, or the PIN is already revoked (same pattern as device
    revoke: revocation never deletes, and re-revoking is a conflict, not a
    silent no-op).
  - **Checklist integration:** see CAP-2 above.
  - **Cross-tenant isolation:** every staff lookup filters by `id` then
    checks `tenantId === owner.tenantId` before touching the row (404
    otherwise) - proven directly in `test/staff-roles.e2e-spec.ts`, not just
    the RLS layer.
- **PIN authentication is out of scope for this story** - no POS PIN-login
  surface exists yet to test against. `pin_revoked_at` is the field any
  future PIN-login path must check (not just `pin_hash` equality) for a
  revoked PIN to actually stop authenticating; the e2e suite asserts the DB
  state and the argon2 hash directly instead.

## Integration points for story 6+ and beyond

- None of CAP-4's tables are read by another CAP yet. A future POS/QR
  price-setting flow must write through `item_prices` the same way (AD-11:
  "this rule is scoped to the entity, not the surface") - never add a second
  price-writing path.
- CAP-10's `GET /admin/v1/outlets` is the outlet-switcher source for every
  later outlet-scoped screen (floor plan, devices, staff) - call it instead
  of re-deriving outlet lists from another table.
- `TenantCapability` (`tenant_capabilities`, Platform Console) is a
  tenant-wide switch set by the operator; `OutletCapability`
  (`outlet_capabilities`, this story) is a distinct, outlet-scoped set owned
  by Tenant Admin. They are intentionally two tables, not one with an
  optional `outletId` - the two are set by different actors through
  different consoles and answer different questions ("is this feature sold
  to this tenant at all" vs. "is this feature turned on at this outlet").
- **CAP-8's dashboard has no new tables** - it reads `outlets`, `devices`,
  `staff_users`, `menu_items`, and `audit_events`, all written by earlier
  capabilities. When the POS Core Loop adds an Order/Bill/Payment model,
  `DashboardService.get()` (`src/admin/dashboard/dashboard.service.ts`) is
  the one place to wire real sales/margin/labour/waste aggregation in -
  swap `noDataMetric()` for a real query per metric, keep the
  `{ amountMinor, currency, hasData, message }` shape so `hasData: true`
  is the only breaking-looking change a client sees.

## Data model

- `owner_invites` (existing, Platform Console) - gained a nullable `used_at`
  column so accept-invite can tell "already used" apart from "expired".
- `owner_users` - the admin realm's principal. Tenant-scoped, `@@unique([tenantId, email])`,
  RLS `tenant_isolation` + `operator_read` (same posture as every other
  tenant-owned table, AD-5).
- `checklist_progress` - one row per tenant, five nullable
  `*_at` timestamp columns, RLS `tenant_isolation` + `operator_read`.
- New RLS policy `invite_accept_read` on `owner_invites`: the accept-invite
  flow authenticates by possession of the raw token, before any `tenant_id`
  is known, so it needs a narrow cross-tenant SELECT under an explicit
  `app.invite_accept_context = 'invite'` setting - never by disabling RLS.
  Proven in `test/rls.e2e-spec.ts`.
- `menu_items` (existing, Platform Console's onboarding seed) - lost its
  `price_minor`/`currency` columns and gained `short_name` (PRD FR-10, KOT
  label) and `created_at`. A new `@@unique([tenantId, categoryId, name])`
  stops two items sharing a name within one category. The onboarding sample-
  menu seed (`src/ops/tenants/tenants.service.ts`) was updated to match:
  it writes a `short_name` per seeded item and creates an `item_prices` row
  instead of setting a price column directly.
- `item_prices` (new, AD-11) - insert-only price history. Each row is
  `{ itemId, priceMinor, currency, createdAt }`; the current price for an
  item is its latest row by `createdAt`. RLS is append-only by construction
  (same posture as `audit_events`): forced RLS with an `INSERT` policy and
  `SELECT` policies for tenant/operator context, and **no `UPDATE`/`DELETE`
  policy at all** - the DB physically refuses an in-place price change for
  every non-superuser role, not just by application convention. This binds
  every writer of `item_prices`, not only this story (AD-11) - the
  onboarding sample-menu seed above writes through it too.
- `menu_import_drafts` (new) - see CAP-3 above.
- `item_prices` (extended, this story) - gained `variantId`, `outletId`
  (both nullable FKs), `channel` (nullable `PriceChannel` enum: `dine_in`,
  `takeaway`, `delivery`, `qr`, `aggregator`), and `effectiveAt` (defaults to
  `now()`). Each of the three new dimensions is independently nullable and
  null means "unscoped on this dimension" (prices the base item / applies to
  every channel / applies tenant-wide) - `menu/pricing.ts` picks the most
  specific eligible row. Story 2's append-only RLS policies are unchanged;
  the new columns don't need new policies (RLS is row-scoped by `tenant_id`
  only). The old `itemId, createdAt` index was replaced by
  `itemId, variantId, effectiveAt` - the shape the new read actually queries.
- `item_variants` (new) - e.g. Half/Full. `@@unique([itemId, name])`.
- `modifier_groups` / `modifiers` / `item_modifier_groups` (new) - tenant-
  scoped, reusable modifier-group catalog (e.g. "Spice Level") with a
  many-to-many join to items. `min_selections`/`max_selections` validated
  0 <= min <= max at write time.
- `allergens` / `item_allergens` (new) - tenant-scoped tag catalog + item
  join. Moved here from CAP-3 menu import per the spec amendment.
- `combos` / `combo_components` (new) - a flat-priced bundle of existing
  items. Not versioned - AD-11 binds `item_prices`, not combos.
- `item_outlet_overrides` (new) - per-outlet **availability** override only
  (`{ itemId, outletId, available }`, `@@unique([itemId, outletId])`,
  mutable/upsertable). Per-outlet **price** override does *not* get a
  separate table - it's just an `item_prices` row with `outletId` set, so
  there is exactly one price-writing path (AD-11), not two.
- RLS: every new table gets the standard `tenant_isolation` (SELECT/INSERT/
  UPDATE/DELETE under `app.tenant_id`) + `operator_read` (cross-tenant
  SELECT under `app.operator_context`) pair, same posture as every other
  tenant-owned table.
- `outlets` (existing, Platform Console) - no schema change; CAP-10 is
  purely a new reader.
- `tenants.branding_tokens` (existing, Platform Console) - no schema
  change; CAP-10 is a second reader/writer of the same JSON column.
- `outlet_capabilities` (new) - `{ id, tenantId, outletId, key, enabled,
  updatedAt }`, `@@unique([outletId, key])`, RLS `tenant_isolation` +
  `operator_read`. Distinct from the pre-existing (and, before this story,
  unused) `tenant_capabilities` table - see "Integration points" above for
  why they stay two tables.
- `floors` (new, CAP-5) - `{ id, tenantId, outletId, name, sortOrder,
  createdAt, deletedAt }`.
- `dining_tables` (new, CAP-5) - `{ id, tenantId, floorId, label, x, y,
  width, height, shape (circle/square/rectangle), seatCapacity, createdAt,
  updatedAt }`. Bounds are plain integers in the editor's own grid units -
  no unit conversion happens in this service.
- `printers` (new, CAP-5) - `{ id, tenantId, outletId, name, renderMode
  (text/bitmap), createdAt, deletedAt }`, `@@unique([outletId, name])`.
- `stations` (new, CAP-5) - `{ id, tenantId, outletId, name,
  ageingThresholdMinutes, primaryPrinterId?, fallbackPrinterId?, createdAt,
  updatedAt, deletedAt }`, `@@unique([outletId, name])`. No
  `station_printers` join table - a station only ever needs one primary +
  one optional fallback printer (see the design's Kitchen Routing panel), so
  a direct nullable FK pair covers it without unused multiplicity.
- `devices` / `enrolment_codes` (existing, Platform Console CAP-4, unchanged
  schema) - CAP-6 adds no columns; it's a second reader/writer of the same
  tables through the same service (AD-12).
- `staff_users` (new, CAP-7) - `{ id, tenantId, roleId, name, email?,
  pinHash?, pinIssuedAt?, pinRevokedAt?, createdAt, updatedAt }`, RLS
  `tenant_isolation` + `operator_read`. Distinct from `owner_users` (the
  admin console principal) the same way `OperatorUser`/`OwnerUser` are
  already kept apart - staff sign into the POS with a PIN, never the admin
  console. `roleId` is a required FK to `roles`, never a string column - the
  FK plus the service-level seeded-role check are what make "no free-text
  roles" a hard invariant, not just a UI restriction.

## Key decisions

- No separate `/admin/v1/auth/login` endpoint in this story - the SPEC's
  CAP-1 success criterion is "no extra login step" after accepting an
  invite, and nothing in scope calls for a returning-owner login flow yet.
  Add one when a story needs it.
- All five checklist steps are required for go-live (no optional/required
  split) - the SPEC states no product decision to make any step optional.
- CAP-3's commit has no user-supplied "reason" field. The SPEC's Constraints
  section scopes mandatory audit reasons to destructive/security-relevant
  actions (role change, PIN revoke, price change on an *existing* item);
  importing a fresh menu is a routine content edit, so it's still audited
  (AD-6, action `menu.imported`) but with a system-generated reason string,
  not an owner prompt - matching CAP-2's `go-live` audit row, which follows
  the same pattern.
- CAP-4's only audited, reason-required mutation is a price change
  (`POST /items/:id/prices`) - the SPEC Constraints section names price
  change explicitly alongside role change and PIN revoke as
  security-relevant. Category/item/variant/modifier-group/allergen/combo
  CRUD and the 86 toggle are all routine content edits, no reason prompt -
  including item/category *deletion*, which the SPEC text doesn't add to
  the named security-relevant list (a judgment call - flagged for product
  review if that reading is wrong).
- The 86 toggle is a plain `MenuItem.available` boolean, not versioned. AD-11
  binds price history, not availability - re-versioning it would be
  unrequested complexity for a field the SPEC describes as immediate.
- Per-outlet price override reuses `item_prices.outletId` rather than a
  second price field on `item_outlet_overrides`, so AD-11's "insert-only"
  guarantee has exactly one writer to reason about, not two that could
  drift out of sync.
- List and detail item responses share one shape (full nested `variants`/
  `modifierGroups`/`allergens`) rather than a lighter list projection -
  console item counts are small enough that the simpler, single shape beat
  maintaining two.
- Resolved prices are deliberately NOT embedded in the item list/detail
  response. `GET /items/:id/price` is the one well-tested current-price
  read; embedding it into every list row would either duplicate that logic
  or silently couple the list response to a fixed channel/outlet the caller
  didn't choose. The web client calls the price endpoint per cell it needs
  to render.
- `GET /admin/v1/outlets` returns `{ id, name, address, type, timezone }`,
  not the `{ id, name, city }` shape assumed at kickoff - the real `outlets`
  table (Platform Console's onboarding wizard) has no `city` column. This is
  the endpoint's actual, load-bearing shape for the web outlet switcher.
- Branding `PUT` merges rather than replaces, even though PUT conventionally
  implies full replacement - the T10 form design (independent color/font/
  corner-radius/logo/receipt fields, each with its own save affordance in
  spirit) means a client saving one field must not be able to null out every
  other token by omission. Documented here since it's a deliberate deviation
  from strict PUT semantics.
- Outlet capabilities live in a new `outlet_capabilities` table rather than
  reusing `tenant_capabilities` - the latter has no `outletId` column and is
  unique on `(tenantId, key)`, which cannot express "this key, this specific
  outlet." Repurposing it would have meant a breaking shape change to an
  existing (if currently unused) table; a new table is the smaller diff.
- No capability-catalogue validation on `key` (no closed enum, no lookup
  table) - the SPEC lists QR ordering/kiosk/token queue "etc." as examples,
  not an exhaustive set, and restaurant-type-driven defaults aren't
  specified. A future story that needs a fixed catalogue (e.g. to drive
  which toggles the UI renders) can add one without touching this write
  path.
- CAP-5 overlap policy: reject (409), not auto-adjust - see the CAP-5
  section above for the reasoning. Both are legitimate readings of the
  SPEC's "rejected or auto-adjusted (owner's choice)" line; reject was
  simpler to specify precisely and easier for the owner to reason about.
- CAP-5 stations reference printers via two direct nullable FKs
  (`primaryPrinterId`/`fallbackPrinterId`) rather than a `station_printers`
  join table - the product only ever needs one primary + one fallback per
  station, so a join table would model multiplicity nothing uses.
- CAP-5's `noPrinterAcknowledged` is a request-only flag, never persisted -
  the station's actual no-printer state is just `primaryPrinterId = null`.
  Re-clearing an already-printerless station's name via `PATCH` doesn't
  re-trigger the gate; only a request that would *change* the station to
  printerless does (creation with no printer, or an explicit
  `primaryPrinterId: null` on update).
- CAP-5's `DELETE /floors/:floorId` (issue #92) refuses with 409
  `floor_has_tables` rather than cascade-deleting a floor's tables - an owner
  who wants a floor gone must move or delete its tables first, so a floor
  full of tables never disappears by one misclick. `PATCH /tables/:tableId`
  still cannot move a table across floors - not in the designed screen or the
  SPEC text; added only if a later story needs it.
- CAP-7's `PATCH /staff/:id` (including a role reassignment) is treated as a
  routine content edit, not audited - only `revoke-pin` requires a reason
  and writes an `audit_events` row. This is a judgment call: the SPEC's
  Constraints section lists "role change" in the same parenthetical as PIN
  revoke and price change as security-relevant examples, which could be
  read to mean role *reassignment* itself needs an audited reason too. The
  codebase's actual precedent (CAP-4's price-change-only audit, CAP-5/CAP-10
  writing no audit rows at all) reads that parenthetical as illustrative
  examples across three capabilities rather than a literal per-field list,
  and staff creation/editing has no closer analogue than "adding a menu
  category" (explicitly named routine in the same sentence) - but flagged
  here for product review if the stricter reading was intended.
- CAP-7 does not model outlet-scoped staff access (no `outletId` on
  `staff_users`, no per-outlet role assignment) despite the SPEC's CAP-7
  intent line mentioning "outlet-scoped roles" - `roles` itself is
  tenant-wide, not outlet-scoped, and no outlet-access data model exists
  anywhere in this codebase to extend. The agreed backend contract for this
  story (`POST/PATCH /staff` with a single `roleId`, no outlet list) doesn't
  carry one either. Flagged as a likely follow-up story, not built here.
- A staff PIN is a random 4-digit numeric code (matches the 4-dot indicator
  in the T7 design render), hashed with argon2 - the same hashing library
  `owner_users.password_hash` already uses, since no PIN-specific hashing
  convention exists yet anywhere in the codebase.
- CAP-8 deliberately ships no sales/margin/labour/waste aggregation, ever
  returning `hasData: false` zeros with an explanatory message instead of
  fabricated figures - there is no Order/Bill/Payment model anywhere in
  this codebase for the POS Core Loop to have written, so there is nothing
  honest to aggregate yet. This was verified by grepping the schema before
  writing any code, not assumed.
- CAP-8's `staffCount`/`menuItemCount` are tenant-rollup-only, not
  per-outlet, even though the task brief for this story sketched them as
  per-outlet fields - `staff_users` has no outlet linkage at all (see the
  CAP-7 note above) and `menu_items` is one shared tenant-wide catalog
  (CAP-4: only per-item availability is outlet-overridable). Reporting the
  same tenant total on every outlet row would look like real per-outlet
  data it isn't; putting both counts only where they're actually true was
  judged more honest than matching the originally-sketched shape. `device`
  is the one of the three that genuinely has an `outletId`, so it alone is
  reported both per outlet and summed in the rollup.
- `tenant.goLiveAt` is derived from the `tenant.went_live` audit event
  (CAP-2) rather than a new column - the value already exists in the audit
  trail; adding a dedicated `Tenant.goLiveAt` column would duplicate it
  with no independent source of truth.
