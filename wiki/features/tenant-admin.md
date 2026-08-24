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
  - `floor_plan` - CAP-5, once a floor/table exists.
  - `menu_import` - **done (CAP-3, this story)** - `MenuImportService.commit`
    calls `ChecklistService.updateStep` directly on a successful commit.
  - `devices` - CAP-6, once a device is enrolled for the tenant (reuses the
    Platform Console device/enrolment-code service per AD-12).
  - `staff` - CAP-7, once at least one non-owner user is invited.

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
