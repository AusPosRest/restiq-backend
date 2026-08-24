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
