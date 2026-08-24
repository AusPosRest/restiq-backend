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
- **Integration points for stories 2, 5, 6, 7:** none of the five steps is
  derived from another table today - every step is a plain PATCH target.
  When a story ships the real feature behind a step, it should call
  `PATCH /admin/v1/checklist/:step` from its own write path instead of
  leaving the owner to tick it manually:
  - `outlet_details` - the outlet-details editing story.
  - `floor_plan` - CAP-5, once a floor/table exists.
  - `menu_import` - CAP-3 (AI-assisted import), once an import is committed.
  - `devices` - CAP-6, once a device is enrolled for the tenant (reuses the
    Platform Console device/enrolment-code service per AD-12).
  - `staff` - CAP-7, once at least one non-owner user is invited.

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

## Key decisions

- No separate `/admin/v1/auth/login` endpoint in this story - the SPEC's
  CAP-1 success criterion is "no extra login step" after accepting an
  invite, and nothing in scope calls for a returning-owner login flow yet.
  Add one when a story needs it.
- All five checklist steps are required for go-live (no optional/required
  split) - the SPEC states no product decision to make any step optional.
