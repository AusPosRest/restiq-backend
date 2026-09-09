# Platform Console (Internal Operator Console) - backend

Backend for the `/ops` realm (AD-3): the internal operator console. This
file doesn't yet document Platform Console's full 7-story pipeline
(operator auth, tenant onboarding/directory, subscriptions, sync health,
dead-letter queue) - it exists today to carry one cross-reference note
that Tenant Admin's CAP-6 depends on. Expand it story-by-story if/when a
future change touches this realm's own docs.

## CAP-4 - Device fleet (`src/ops/devices/`)

- `GET /ops/v1/devices`, `POST /ops/v1/devices/enrolment-codes`,
  `POST /ops/v1/devices/enroll`, `PUT /ops/v1/devices/:id/hub`,
  `POST /ops/v1/devices/:id/revoke`, `POST /ops/v1/devices/:id/heartbeat` -
  `DevicesService` (`devices.service.ts`).
- **Also called from `/admin` (AD-12, added by tenant-admin story 6):**
  Tenant Admin's Devices & Printers screen (`src/admin/devices/`) calls
  this same `DevicesService` for its own outlet-scoped device list and
  enrolment-code generation - not a second implementation. `DevicesService`
  is now exported from `src/ops/index.ts` and `OpsModule` for that reuse.
  Two things changed here to support it, both backward-compatible for the
  existing `/ops` callers:
  - `list()` gained an optional `outletId` query filter (ops never passes
    one, so fleet/tenant-scoped ops reads are unaffected).
  - `enroll()` now flips the tenant's `checklist_progress.devicesAt` on the
    first device ever enrolled for that tenant, in the same transaction as
    the device row and its `audit_events` write. This lives here (not in
    `admin/checklist`) deliberately: `admin` already imports this module's
    barrel to reuse `DevicesService`, so the reverse import would be a
    circular module dependency. `checklist_progress` is a plain table on
    the same region plane, so the flip is a direct Prisma write, not a
    `ChecklistService` call.
  - See `wiki/features/tenant-admin.md`'s CAP-6 section for the `/admin`
    side of this reuse, and `test/admin-devices.e2e-spec.ts` for the
    cross-tenant isolation and shared-mechanism proof.
- **Also called from the new public `/device` realm (issue #89, AD-12/AD-13):**
  `POST /device/v1/enroll` (`src/device/enroll/`) lets a device redeem its
  own one-time enrolment code with no operator session at all - the product
  intent for a real device, unlike `POST /ops/v1/devices/enroll` which
  exists for the internal console and stays operator-token-gated. It calls
  the same `DevicesService`, through a new `enrollWithActor()` extracted
  from `enroll()` (the request/expiry/one-time-use checks and the `Device`
  row shape are identical - `enroll()` itself is now a one-line wrapper
  around it for the ops-token case). The two callers differ only in who is
  accountable for the `audit_events` row: an `EnrollActor` carries either
  the ops operator's `{ id, email }`, or, for a device with no operator
  identity at all, `{ actorId: null, actorEmail: 'device:<hardwareKeyFingerprint
  prefix>' }` (`actorId` is nullable on `audit_events` for exactly this
  case; `actorEmail` is not, hence the synthetic label).
  - `/device/*` carries no auth guard at all (there's nothing to check - the
    one-time code is the only credential a device presents), unlike
    `/ops`/`/admin`/`/pos`/`/guest` which each get their own `APP_GUARD`
    early-returning true outside its own path prefix; `/device` simply
    isn't matched by any of the four, so no guard changes were needed to
    exempt it.
  - **Rate limited (issue #95):** enrolment codes are short (`AAA-AAA`,
    ~33^6 space), so this route carries `EnrollRateLimitGuard`
    (`src/device/enroll/enroll-rate-limit.guard.ts`) - 10 attempts per 5
    minutes per client IP (`ENROLL_RATE_LIMIT_ATTEMPTS`/
    `ENROLL_RATE_LIMIT_WINDOW_MS`), a hit over the limit returning `429
    rate_limited` in the usual `{ error: { code, message } }` shape. No
    throttling package exists anywhere else in this repo, so this is a
    small hand-rolled `CanActivate` rather than a new dependency. It's an
    in-memory `Map<ip, window>`, single-process by design - a
    multi-instance deploy gives each instance its own budget instead of a
    shared one; move to a shared store (Redis) if/when this API scales out.
    Client IP comes from `X-Forwarded-For` (first entry) falling back to
    `req.ip`, so the reverse proxy in front of this route must set that
    header.
  - See `test/device-enroll.e2e-spec.ts` for the public happy path,
    `code_invalid`/`code_expired`/`code_already_used` error coverage, proof
    that the ops-realm enroll endpoint keeps working unchanged, and the
    `rate limiting (issue #95)` block for the 429 behaviour and per-IP
    isolation.

## Tenant lifecycle (issue #117)

Three new mutations on `TenantDirectoryService`/`OpsTenantsController`
(`src/ops/tenants/`), all operator-auth, all requiring `reason` and audited
via the existing `mutate()` helper - the same shape as `activate()`:

- `POST /ops/v1/tenants/:id/deactivate` - `active` -> `inactive`
  (`tenant.deactivated`). `409 conflict` if the tenant is already `inactive`
  or still `provisioning`.
- `POST /ops/v1/tenants/:id/reactivate` - `inactive` -> `active`
  (`tenant.reactivated`). `409 conflict` if the tenant isn't `inactive`.
- `DELETE /ops/v1/tenants/:id` - soft delete: sets `deletedAt`, leaves
  `status` untouched (`tenant.deleted`). Refused with
  `409 { code: 'tenant_has_open_activity' }` if the tenant has any `Order`
  not `closed` or any `Bill` still `open`. A deleted tenant disappears from
  the directory list/detail (`404`) and the `active_tenants`/`outlets` KPIs -
  every directory read already filters `deletedAt: null`.

**Guard enforcement, every realm:** `AdminAuthGuard`, `PosAuthGuard` and
`GuestAuthGuard` (`src/platform/*-auth.guard.ts`) each resolve a `tenantId`
from their own JWT; after verifying the token they now also call
`isTenantBlocked()` (`src/platform/tenant-lifecycle.ts`) - one `set_config` +
`Tenant` select on the tenant's plane - and reject with
`403 { code: 'tenant_inactive' }` when the tenant is `inactive` or
soft-deleted. This is the one place a blocked tenant is rejected regardless
of realm, so the helper lives once in `platform` rather than being
duplicated per guard. The guest realm's pre-token entry point
(`GuestSessionsService.checkAvailability`, `src/guest/sessions/`) carries the
same check inline, since it resolves a tenant from an `outletId` before any
guest token exists and is `@Public()` - it reports the same `not_found`
reason a missing outlet does, never revealing tenant lifecycle state to an
unauthenticated QR scan.

See `test/tenant-lifecycle.e2e-spec.ts` for the deactivate/reactivate
round-trip, the soft-delete/open-activity conflict, and the
admin/pos-realm 403 proof.

## GST applicable + configurable rate (issue #121)

The onboarding wizard's tax step (`TaxComplianceDto`, `src/ops/tenants/
submit.dto.ts`) gains two optional fields alongside the existing
`compositionScheme`:

- `gstRegistered` (`boolean`) - persisted onto the new
  `TenantTaxRegistration` row at `POST /ops/v1/tenants` submit, defaulting to
  `true` when omitted. Mirrors the field `/admin/v1/tax-registration` (see
  `wiki/features/tenant-admin.md`'s CAP-108 section) already exposed to
  owners post-onboarding.
- `gstRatePercent` (`number`, 0-100) - `TenantTaxRegistrationService.provision()`
  (`src/ops/tenants/tenants.service.ts`) rejects it with `400
  validation_failed` when `gstRegistered` is explicitly `false`, since a rate
  with nothing to apply it to is a wizard-input error, not a silently-dropped
  field. Stored as `tenant_tax_registrations.gst_rate_percent NUMERIC(5,2)`,
  nullable - `null` (the omitted case) means "use `pos/bills/tax.ts`'s
  statutory default" (5% IN, 10% AU).

`OpsTenantsService.detail()`'s (`src/ops/tenants/directory.service.ts`)
`taxRegistrations[]` entries now also carry `gstRegistered` and
`gstRatePercent` for the console's tenant-detail read.

See `wiki/features/tenant-admin.md`'s CAP-108 section for the
`/admin/v1/tax-registration` GET/PUT side of the same two fields, and
`src/pos/bills/tax.ts` for how a configured rate changes bill tax math.

## Agreements - versioned platform agreement, owner-signed (issue #132, `src/ops/agreements/`)

- **Intent:** the platform publishes numbered, immutable agreement versions;
  each tenant owner signs the current one from the owner console; operators
  see per-tenant standing (signed / pending) and the signature record.
- **Data:** `agreement_versions` (no `tenant_id`, no RLS - every tenant reads
  the same text; `version` unique, `body_sha256` fixed at publish) and
  `agreement_signatures` (one row per tenant per version, RLS mirrors
  `print_jobs`, cascades with its tenant, RESTRICT on its version). A
  signature stores the typed `signer_name` (the signature itself), signer
  owner id/email, `signed_at`, and `evidence_sha256` = sha256 of
  `bodySha256 \n tenantId \n ownerId \n ownerEmail \n signerName \n signedAt`
  - tamper-evident proof of exactly what was accepted, by whom, when. No
  update or delete route exists for either table.
- **Routes (ops realm):** `GET ops/v1/agreements` (newest first, with
  `signatureCount`), `POST ops/v1/agreements` `{ title, body, reason }` → 201
  with the next gap-free version (a `pg_advisory_xact_lock` serialises
  concurrent publishes) and a control-plane audit row `agreement.published`
  carrying the reason; `GET ops/v1/agreements/:id` (full body);
  `GET ops/v1/tenants/:tenantId/agreements` → `{ current, status:
  'signed' | 'pending' | 'no_agreement', signatures[] }`.
- **Routes (admin realm, `src/admin/agreement/`):** `GET admin/v1/agreement`
  → `{ current (with body) | null, signature | null, history[] }`;
  `POST admin/v1/agreement/:versionId/sign` `{ signerName, accepted: true }`
  → 201 `{ signature }`. `accepted` must be literally `true`; a blank name
  is 400; signing a non-current version is 409 `stale_version`; a second
  signature on the same version is 409 `already_signed`; an unknown version
  is 404. Signing writes a tenant `audit_events` row `agreement.signed`.
- **One service, two callers (AD-12):** `AgreementsService` lives in the ops
  module and is exported for `AdminAgreementController`, the same shape as
  `DevicesService`.
- **Tests:** `test/agreements.e2e-spec.ts` (publish/list/audit, sign/repeat/
  stale/new-version reopen, cross-tenant isolation, unauthenticated) and an
  `agreement_signatures` probe case in `test/rls.e2e-spec.ts`.
- **Not built (by design):** platform countersignature, gating go-live on a
  signature, PDF export, third-party e-sign. The typed-name-plus-hash record
  is the evidence; swap in a provider if a legal review asks for one.
