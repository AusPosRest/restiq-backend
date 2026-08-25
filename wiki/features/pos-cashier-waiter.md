# POS Cashier & Waiter (Web Prototype) - backend

Backend for the `/pos` realm (AD-13): the online-only web prototype standing
in for the native Android POS/KDS build. See
`restiq-design/docs/specs/spec-pos-cashier-waiter/SPEC.md` for the full
capability set (CAP-1..11); this doc tracks what's actually built here,
story by story.

## CAP-1 - PIN login and shift clock

- **Intent:** staff authenticate at a shared device with a 4-digit PIN and
  clock in/out; 5 wrong attempts locks that PIN for 30 seconds, and a
  successful PIN starts a `pos`-realm session and records a clock-in if none
  is open for that staff member today.
- **Built:** new fourth disjoint auth realm `pos` (AD-13), same pattern as
  ops/admin (AD-3/AD-10): `aud:"pos"`, own secret `POS_JWT_SECRET`,
  principal `{ id: staffId, tenantId, outletId }`. `src/platform/pos-jwt.ts`
  (sign/verify, never throws - `verifyPosToken` returns `null`),
  `src/platform/pos-auth.guard.ts` (`PosAuthGuard`, `CurrentStaff`
  decorator), registered as a third global `APP_GUARD` in
  `platform.module.ts` alongside `OpsAuthGuard`/`AdminAuthGuard`, gating
  `/pos(/|$)`. This is the story that actually stands up the `/pos` HTTP
  surface (`src/pos/`), which CAP-8 below still has no caller for.
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

### CAP-1 integration points for later stories

- CAP-11 (device & staff attendance status, story 11) reads `ClockEvent`
  rows directly for "who's clocked in today" - no new mutation needed,
  this story's rows are the real data source.
- CAP-2..CAP-10's `pos/*` modules should depend on `CurrentStaff`/
  `PosPrincipal` from the platform barrel exactly like this story's own
  controllers do, and reuse this story's `PosAuthGuard` (already global) -
  never re-verify a pos token themselves.
- `platform/manager-auth` (CAP-8 below) is a distinct concern - it
  authorises manager-gated *actions* with a manager's own PIN, not staff
  login. Do not conflate it with this story's staff PIN login.

## CAP-8 - Manager authorisation gate

- **Intent:** void-after-fire, comp, discount-above-threshold, price
  override, refund, and no-sale drawer-open each require a manager's PIN
  plus a mandatory reason code before they take effect, and each writes an
  `audit_events` row (actor, approver, both timestamps, reason) in the same
  transaction as the mutation it gates (AD-15, generalizing AD-6).
- **Built** (`src/platform/manager-auth.service.ts`, exported from the
  `src/platform` barrel per AD-2): one shared, callable `ManagerAuthService`
  every gated mutation calls into, instead of six reimplementations of the
  same PIN-check-plus-audit-row logic. No controller/route of its own - it
  is pure shared infrastructure for four future call sites (see "How to
  call this" below). Registered as a `PlatformModule` provider, so any
  module that already imports `PlatformModule` (every module in this app
  does) gets it via constructor injection with no extra module wiring.

### "Manager-capable" - the decision this story had to make

A StaffUser is manager-capable when their `Role.isManager` is `true` - a
new boolean column on `Role` (`prisma/schema.prisma`), **not** a hardcoded
`role.name === 'Manager'` string check. Seeded `true` for `'Owner'` and
`'Manager'` only, `false` for `'Cashier'`/`'Waiter'`/`'Kitchen'`/`'Accountant'`
(`SYSTEM_ROLES` in `src/ops/tenants/tenants.service.ts`, migration
`20260824960000_manager_authorisation` backfills existing tenants).

Why a flag over a name check: it's one string comparison cheaper today, but
tying authorisation to a display name couples it to a value tenant-admin/CAP-7
already lets an owner rename in principle, and a name check can't express
"Owner is also manager-capable" without hardcoding a second string. A flag on
`Role` means a tenant's set of approving roles can change later (e.g. letting
`Accountant` approve refunds) without touching `manager-auth.service.ts` at
all - the exact same "role property, not magic string" posture the codebase
already uses for `Role.isSystem`.

### Design decision - a callable service, not a guard/decorator

The task allowed either. A Nest guard runs before the route handler and has
no way to join the caller's own mutation transaction - but AD-6 requires the
audit row land in the **same transaction** as the mutation it gates. Splitting
this into two plain methods instead - `authorize()` (read-only, its own short
transaction, called before the caller's mutation) and `recordApproval()` (a
plain write the caller invokes **inside** its own transaction) - composes
with that requirement directly. A guard/decorator would need an awkward
side-channel to hand a transaction handle back out through Nest's request
pipeline, and couldn't be unit-tested without booting HTTP. This also means
every future call site calls it as two normal awaited method calls - no
decorator wiring, no metadata reflection to get wrong.

### How to call this (read this before wiring void/discount/refund/no-sale)

```ts
import { ManagerAuthService, MANAGER_GATED_ACTIONS } from '../platform'
// MANAGER_GATED_ACTIONS: ['void_after_fire', 'comp', 'discount_above_threshold',
//   'price_override', 'refund', 'no_sale_drawer_open'] - the ManagerGatedAction
// union type. Pass one of these six literals; a typo is a compile error.

// 1. Verify BEFORE your own mutation. Throws BadRequestException (empty/missing
//    reason - checked before the PIN, cheapest-check-first) or
//    UnauthorizedException (wrong PIN / PIN belongs to a non-manager / no
//    manager-capable staff exist for the tenant - all three look identical to
//    the caller and take the same time, by design, to avoid enumeration).
const approval = await this.managerAuth.authorize(
  'void_after_fire',   // actionType: ManagerGatedAction
  tenantId,            // string
  outletId,            // string - accepted for interface parity, not
                        // currently used to filter approvers (see below)
  dto.managerPin,       // string - the entered PIN, raw
  dto.reason,           // string - the mandatory reason code
)
// approval: { approverId, approverName, roleId, roleName, tenantId,
//             actionType, reason } - tenantId/actionType/reason are carried
// through from this call, so you never re-pass them to recordApproval below
// and they can't drift from what was actually verified.

// 2. Do your own mutation AND record the approval in ONE transaction (AD-6):
await plane.$transaction(async (tx) => {
  await setTenantContext(tx, tenantId)
  // ... your module's own mutation (void the line, apply the discount,
  //     issue the credit note, open the drawer) ...
  await this.managerAuth.recordApproval(tx, approval, {
    actorId: actingStaff.id,          // optional - the StaffUser who
                                       // triggered the action (not the
                                       // approving manager)
    actorEmail: actingStaff.email ?? actingStaff.name, // required by the
                                       // audit_events schema (actorEmail is
                                       // NOT NULL) - StaffUser.email is
                                       // optional, so fall back to name
                                       // yourself if it's unset
    occurredAt: new Date(),           // when the gated action happened
  })
})
```

- **outletId is accepted but not yet load-bearing.** `StaffUser` rows are
  tenant-scoped, not outlet-scoped, in this schema (SPEC: staff pick an
  outlet right after login, they aren't assigned to one) - so it currently
  plays no part in finding a candidate approver, and it is **not** persisted
  on the audit row either (`audit_events` has no outlet column). It's in the
  signature for parity with the money-path's outlet-scoped shape (AD-14) so
  every call site can pass the same request context uniformly. If your
  caller needs outlet context in its own trail, put it in your `reason`
  string or your own mutation's audit row - not this one.
- **The PIN check has no staff-selector input** - by design, matching CAP-1's
  PIN-login shape (a device knows a PIN, not which staff member typed it).
  `authorize()` loads every manager-capable, non-revoked `StaffUser` for the
  tenant and tries `argon2.verify` against each until one matches. Fine for
  the realistic size of a restaurant's manager roster; if that ever becomes a
  scaling concern, the query in `authorize()` is the one place to revisit,
  not the six call sites.
- **`action` written to `audit_events` is exactly the `actionType` you
  passed** - `'void_after_fire'`, `'comp'`, `'discount_above_threshold'`,
  `'price_override'`, `'refund'`, or `'no_sale_drawer_open'`. No domain
  prefix is added. If your module wants a more specific action string for
  its *own*, separate non-gated audit trail, write that as a second row -
  don't try to smuggle extra context into this one's `action` field.
- **`reason` is the one reason** - the mandatory reason code SPEC requires
  for the gated action IS the reason recorded on the approval's audit row.
  There is no separate "reason for the mutation" vs. "reason for the
  approval" - design your DTO with a single `reason` field.

### Test coverage (`test/manager-auth.e2e-spec.ts`, 6 tests, e2e against a
real Postgres test DB - no caller exists yet, so this story tests the
service directly rather than through an HTTP endpoint)

- Valid manager PIN + valid reason -> approved, with the correct approver
  identity returned.
- Wrong PIN -> rejected (`UnauthorizedException`).
- Missing/blank reason -> rejected (`BadRequestException`) with **no
  manager seeded at all** - proving the reason check runs before any PIN
  lookup (cheapest-check-first), not just that it eventually fails.
- A non-manager StaffUser's correct PIN -> rejected - proves `isManager`,
  not merely "has an active PIN", gates approval.
- A manager PIN from a different tenant never matches (cross-tenant
  isolation, RLS-backed).
- `recordApproval` writes actor, approver, reason, and both timestamps
  (`occurredAt`, `recordedAt`) into a real `audit_events` row, inside a
  transaction standing in for the caller's own mutation transaction.

## Data model

- `clock_events` (CAP-1, new table) - `id`, `tenantId`, `staffId`,
  `outletId`, `type` (`clock_in`/`clock_out`), `occurredAt`, `createdAt`.
  RLS-protected like every other tenant-owned table. Insert-only: a day's
  attendance is a sequence of events, never edited in place.
- `roles.is_manager` (CAP-8, new column, default `false`) - see
  "manager-capable" above. Migration `20260824960000_manager_authorisation`
  adds it and backfills `true` for existing `'Owner'`/`'Manager'` rows.
- `audit_events.approver_id` / `audit_events.approver_name` (CAP-8, new,
  nullable columns) - populated only for manager-gated audit rows; `null`
  for every routine AD-6 audit action that has no approval step (e.g.
  `staff.role_changed`, `staff.pin_revoked`). `approverName`, not
  `approverEmail`: the approving `StaffUser`'s email is optional but name is
  required, so name is what's guaranteed to identify them. No RLS policy
  change needed - both are plain additive columns on a table whose existing
  `tenant_id`-scoped policies already cover them.

## Integration points for stories 4, 8, 10, and 2 (pos/CAP-3, CAP-7, CAP-9, CAP-10)

- Every gated mutation (order void-after-fire and comp, bill
  discount-above-threshold and price override, refund, shift no-sale
  drawer-open) calls `ManagerAuthService.authorize()` then
  `.recordApproval()` exactly as shown above - **never** a per-action PIN
  check or a second `audit_events` insert helper.
- None of those four stories need to touch `Role.isManager` or
  `AuditEvent.approverId`/`approverName` directly - `ManagerAuthService` is
  the only reader/writer of those columns.
- If a future product decision wants a role beyond Owner/Manager to approve
  gated actions, flip that role's `isManager` to `true` (a data change) -
  `manager-auth.service.ts` needs no code change for that.

## Key decisions

- AD-13 explicitly does **not** bind a pos session to an enrolled Device
  row (unlike AD-12's real device model) - any authenticated browser can
  act as a POS terminal in this prototype. Logged, deliberate, prototype-
  only relaxation; the native Android build must bind sessions to real
  enrolled devices.
- `StaffUser` has no `outletId` column (it's tenant-wide), which is why
  CAP-1's login is two-step rather than embedding the outlet in the PIN
  check itself - the outlet is resolved after the PIN, not as part of it.
- The intermediate outlet-selection token reuses `POS_JWT_SECRET` rather
  than introducing a fifth secret - realm separation is enforced by
  **audience** (`pos` vs `pos-pending`), the same "distinct audience, not
  necessarily a distinct key" shape AD-3/AD-10 already use for keeping
  their own two audiences on two different secrets, extended one step
  further within a single realm's own login handshake.
- `pinStatus()` is reused across the module boundary rather than
  reimplemented: it is now exported from `admin/index.ts` (a pure function,
  safe to share per AD-2's barrel rule). `setTenantContext` is instead
  duplicated as `src/pos/tenant-context.ts` and, separately, into
  `manager-auth.service.ts` - that one-line RLS helper is already
  copy-pasted per admin submodule in this codebase (see its own comment),
  and neither `pos` nor `platform` may import it from `admin` regardless
  (`admin` already imports `platform`; the reverse would be circular) - the
  ponytail "one line? one line" step, applied consistently.
- `ManagerGatedAction` is a closed TypeScript union (`MANAGER_GATED_ACTIONS`),
  not a free-text `string`, so the four future call sites get a compile-time
  guardrail against a typo silently producing an unrecognised `action` value
  in `audit_events`.
- `authorize()` does one dummy `argon2.verify` on every failure path (wrong
  PIN, non-manager PIN, or zero manager-capable staff), mirroring
  `OpsAuthService.dummyHash` (and CAP-1's own `PosAuthService.dummyHash` -
  same reasoning, applied independently) - so a caller can't learn from
  response timing whether a given tenant has any managers/staff at all.
