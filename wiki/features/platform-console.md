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
  - **Known risk, not addressed here:** enrolment codes are short
    (`AAA-AAA`, ~33^6 space) and this endpoint has no rate limiting - no
    throttling package or pattern exists anywhere else in this repo, so
    none was invented for this one route. A high-volume public brute-force
    of live enrolment codes within their 15-minute TTL is possible; the
    real mitigation is normal infra-level rate limiting (reverse proxy/WAF)
    in front of this route, not application code, and should be tracked as
    a followup before this leaves prototype status.
  - See `test/device-enroll.e2e-spec.ts` for the public happy path,
    `code_invalid`/`code_expired`/`code_already_used` error coverage, and
    proof that the ops-realm enroll endpoint keeps working unchanged.
