# POS Cashier & Waiter (Web Prototype) - backend

CAP-1 PIN login and shift clock.

## Capabilities

- **CAP-1** PIN login and shift clock - staff authenticate at a shared device
  with a 4-digit PIN and clock in/out; 5 wrong attempts locks that PIN for
  30 seconds, and a successful PIN starts a `pos`-realm session and records a
  clock-in if none is open for that staff member today.

## What's built

- New fourth disjoint auth realm `pos` (AD-13), same pattern as
  ops/admin (AD-3/AD-10): `aud:"pos"`, own secret `POS_JWT_SECRET`,
  principal `{ id: staffId, tenantId, outletId }`. `src/platform/pos-jwt.ts`
  (sign/verify, never throws - `verifyPosToken` returns `null`),
  `src/platform/pos-auth.guard.ts` (`PosAuthGuard`, `CurrentStaff`
  decorator), registered as a third global `APP_GUARD` in
  `platform.module.ts` alongside `OpsAuthGuard`/`AdminAuthGuard`, gating
  `/pos(/|$)`.
- `POST /pos/v1/auth/login` `{ tenantId, pin }` - verifies the PIN against
  this tenant's active `StaffUser` rows (reusing `pinStatus()` from
  `admin/staff/staff.service.ts` verbatim, exported through the admin
  barrel for this). A single-outlet tenant finalises immediately (signs a
  pos token, records the clock-in). A tenant with more than one outlet
  instead gets `{ status: "select_outlet", pendingToken, outlets }` -
  `pendingToken` is a short-lived (5 min), *different-audience*
  (`aud:"pos-pending"`) token signed with the same `POS_JWT_SECRET`, so it
  can never satisfy the real `/pos` guard.
- `POST /pos/v1/auth/select-outlet` `{ pendingToken, outletId }` - verifies
  the pending token, checks the outlet belongs to that tenant, and
  finalises the same way (`src/pos/auth/auth.service.ts`).
- Lockout: 5 wrong attempts for the exact `(tenantId, pin)` pair locks that
  pair for 30 seconds (`src/pos/auth/lockout.ts`, in-memory `Map` -
  documented single-instance-only tradeoff, acceptable for this prototype,
  no schema churn). Scoped to the guessed PIN, not the tenant or a staff
  row, since a failed brute-force guess can't be attributed to one staff
  member until it succeeds. Returns `429 locked_out`.
- New `ClockEvent` model (`clock_in`/`clock_out`), RLS-protected the same
  way as every other tenant-owned table (`tenant_isolation` +
  `operator_read` policies, migration
  `20260825035228_pos_auth_clock`). Clock-in-once-per-local-day is enforced
  by reading the staff member's latest event and comparing calendar dates
  in the outlet's own timezone (`Outlet.timezone`, not UTC or the server
  clock) - `src/pos/clock/clock.util.ts#recordClockInIfNeeded`, called from
  inside the login/select-outlet transaction.
- `POST /pos/v1/clock/out` (guarded - needs a real pos session) - ends the
  day's open clock-in; `409 not_clocked_in` if the staff member's latest
  event isn't already an open clock-in (`src/pos/clock/clock.service.ts`).

## Integration points for later stories

- CAP-11 (device & staff attendance status, story 11) reads `ClockEvent`
  rows directly for "who's clocked in today" - no new mutation needed,
  this story's rows are the real data source.
- CAP-2..CAP-10's `pos/*` modules should depend on `CurrentStaff`/
  `PosPrincipal` from the platform barrel exactly like this story's own
  controllers do, and reuse this story's `PosAuthGuard` (already global) -
  never re-verify a pos token themselves.
- `platform/manager-auth` (AD-15, story 9) is a distinct concern - it
  authorises manager-gated *actions* with a manager's own PIN, not staff
  login. Do not conflate it with this story's staff PIN login.

## Key decisions

- AD-13 explicitly does **not** bind a pos session to an enrolled Device
  row (unlike AD-12's real device model) - any authenticated browser can
  act as a POS terminal in this prototype. Logged, deliberate, prototype-
  only relaxation; the native Android build must bind sessions to real
  enrolled devices.
- `StaffUser` has no `outletId` column (it's tenant-wide), which is why
  login is two-step rather than embedding the outlet in the PIN check
  itself - the outlet is resolved after the PIN, not as part of it.
- The intermediate outlet-selection token reuses `POS_JWT_SECRET` rather
  than introducing a fifth secret - realm separation is enforced by
  **audience** (`pos` vs `pos-pending`), the same "distinct audience, not
  necessarily a distinct key" shape AD-3/AD-10 already use for keeping
  their own two audiences on two different secrets, extended one step
  further within a single realm's own login handshake.
- `pinStatus()` and `setTenantContext()` are reused/duplicated rather than
  imported across the module boundary in ways that would defeat AD-2's
  barrel-only import rule: `pinStatus` is now exported from `admin/index.ts`
  (a pure function, safe to share); `setTenantContext` is a one-line RLS
  helper duplicated as `src/pos/tenant-context.ts` (same content as
  `admin/menu/tenant-context.ts`) rather than promoted to a shared module,
  per the ponytail "one line? one line" step.
