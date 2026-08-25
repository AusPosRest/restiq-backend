# POS Cashier & Waiter (Web Prototype) - backend

Backend for the `/pos` realm (AD-13): an online-only restiq-web prototype
standing in for the real native Android POS build. See
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

## CAP-2 - Table map and order ownership/transfer

- **Intent:** staff sees live per-table status (empty/occupied/needs-bill)
  and opens or claims a table's order; a second device can never silently
  edit an order already owned by another staff member - it must go through
  an explicit transfer action naming the new owner.
- **Built** (`src/pos/orders/`, wired via `src/pos/pos.module.ts`,
  `src/pos/index.ts`):
  - `GET /pos/v1/outlets/:outletId/table-map` - every table in the outlet
    with `status: 'empty' | 'occupied'`, plus `orderId`/`ownerId` when
    occupied. Reuses the existing `Floor`/`DiningTable` models from
    tenant-admin/CAP-5's floor-plan module directly (no second table model)
    - a table is "occupied" iff it has a non-`closed` `Order`.
  - `POST /pos/v1/outlets/:outletId/tables/:tableId/order` - opens a new
    `Order` on an empty table (owned by the caller) or returns the table's
    existing order unchanged if one is already open/sent. Viewing an
    occupied table is never a takeover. Always `200` - see the controller
    comment for why this endpoint doesn't distinguish 200-existing from
    201-created.
  - `GET /pos/v1/orders/:orderId` - any staff member may view any order in
    their tenant; viewing never requires ownership.
  - `PATCH /pos/v1/orders/:orderId/status` - owner-only. `open -> sent ->
    closed`, forward-only. A non-owner gets `403 not_owner` naming the
    current owner (`message` + `ownerId`) - never a silent edit.
  - `POST /pos/v1/orders/:orderId/transfer` - `{ newOwnerStaffId, reason? }`,
    callable by **anyone** (not CAP-8-gated - a normal handoff, not one of
    the six manager-authorised actions). Reassigns `ownerId` and writes an
    `audit_events` row (`order.ownership_transferred`) with a fixed
    placeholder reason when the caller omits one, since `audit_events.reason`
    is `NOT NULL`. The old owner cannot mutate the order once this completes.

### Data model

```prisma
model Order {
  id        String      @id @default(uuid(7)) @db.Uuid
  tenantId  String      @map("tenant_id") @db.Uuid
  outletId  String      @map("outlet_id") @db.Uuid
  tableId   String?     @map("table_id") @db.Uuid   // null = counter order (later story)
  ownerId   String      @map("owner_id") @db.Uuid   // -> StaffUser, reassigned only via transfer
  status    OrderStatus @default(open)              // open | sent | closed
  createdAt DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime    @updatedAt @map("updated_at") @db.Timestamptz(6)
}
```

- Migration `20260825100000_pos_order_ownership` (`prisma/migrations/`).
  Standard AD-5 tenant-isolation RLS policy, plus a hand-written partial
  unique index `orders_one_active_per_table` on `(table_id) WHERE table_id
  IS NOT NULL AND status <> 'closed'` - at most one live order per table,
  since the table map's occupied/empty status derives directly from this.
  Prisma's schema language has no partial-index syntax, so this one line is
  hand-added to the `prisma migrate diff` output rather than generated.
- **`tableId` is nullable today and unused as null** - reserved for a later
  counter-order (pos/CAP-6 QSR) story that opens an `Order` with no table.
  This story only ever sets it.
- **AD-14 does not bind this story.** AD-14's insert-only-past-finalisation
  discipline binds pos/CAP-6, 7, 9, 10 - not CAP-2. At this base-fields stage
  (no `OrderLine`, no `Bill` yet) an `Order` is an ordinary mutable draft
  row: status moves forward by plain `UPDATE`, gated by ownership, not by a
  finalise/insert-only discipline. A later story (CAP-7, bill & settle) is
  what actually makes closing an order mean something real.
- **`needs-bill` is a documented TODO, not built.** SPEC's third table-map
  state depends on whether a `Bill` has been requested for the table's
  order - `Bill` doesn't exist yet (a later story introduces it per AD-14).
  See the `TODO(pos/CAP-7 ...)` comment on `TableMapEntry` in
  `src/pos/orders/orders.dtos.ts`.

### The pos auth realm - reconciled with pos/CAP-1 (issue #44)

This story was built before pos/CAP-1's real PIN login (issue #44) merged,
so it originally shipped its own stub of `src/platform/pos-jwt.ts`/
`pos-auth.guard.ts` with a "reconcile once #44 merges" note. That
reconciliation is now done: CAP-1's `signPosToken`/`verifyPosToken`/
`PosAuthGuard`/`CurrentStaff` (`aud: "pos"`, `POS_JWT_SECRET`) are the one
real implementation this story's `pos/orders/` module calls into - no
second signing/verification logic remains. The one merge-time addition CAP-1
didn't originally need: `PosPrincipal` carries `name` (not just `id`/
`tenantId`/`outletId`) because `orders.service.ts`'s ownership-transfer
audit row uses `staff.name` as `actorEmail` directly from the token, without
a second `StaffUser` lookup - `auth.service.ts`'s `finalize()` sets it from
the same `StaffUser` row it already has in hand.

### Test coverage (`test/pos-orders.e2e-spec.ts`, 11 tests, e2e against a
real Postgres test DB)

- Table map shows empty before any order, occupied once one opens (with the
  right `orderId`/`ownerId`), and empty again once the order closes.
- An invalid forward transition (`open` straight to `closed`) is rejected
  `409 invalid_transition`.
- Claiming an already-occupied table returns the *same* order, never a
  second one (also checked directly against the `orders` table row count).
- Any staff member can view an occupied table's order.
- A non-owner's mutation is rejected `403 not_owner`, naming the current
  owner (id and name in the message).
- Transfer reassigns ownership; the new owner can then mutate, the old
  owner is rejected afterward, and an `audit_events` row is written.
- Transferring to a staff member from another tenant is rejected `400`.
- No session -> `401`; another tenant's table map/order -> `404` (never a
  different shape leaking existence).

### CAP-2 integration points for later stories

- pos/CAP-3 (order taking) and pos/CAP-4 (group ordering) extend this
  `Order` with `OrderLine` - the base shape (`id`, `tenantId`, `outletId`,
  `tableId`, `ownerId`, `status`, timestamps) is meant to be extended, not
  replaced. Read the exact field names above before adding `OrderLine`.
- pos/CAP-5 (open/held orders, issue #53, since built - see its own section
  above) lists exactly the rows this story already writes, via a
  tenant/outlet-scoped `findMany` added directly to this story's
  `OrdersService`, and reuses `transfer()` unchanged for take-over.
- pos/CAP-6 (QSR counter) is the first caller that creates an `Order` with
  `tableId: null`.
- pos/CAP-7 (bill & settle) is what finally makes `status: 'closed'` mean
  something (today it's just a terminal status with no side effects) and is
  what the table map's `needs-bill` TODO depends on.
- pos/CAP-1 (PIN login, issue #44, since merged) is what this story's
  `/pos` auth realm now defers to - see "The pos auth realm" above.

### CAP-2 key decisions

- Table map reads `Floor`/`DiningTable` directly via Prisma inside
  `OrdersService`, rather than importing tenant-admin's `FloorPlanService`:
  that service's methods take an `AdminPrincipal`, not a `PosPrincipal`, and
  the read here is a plain tenant/outlet-scoped `findMany` - reusing the
  *models* (as the story requires) doesn't require reusing that service's
  owner-shaped API.
- `openOrClaimTable` is check-then-create inside one transaction, with the
  `orders_one_active_per_table` unique index as a race backstop (caught via
  `isUniqueViolation`, same one-line convention as `admin/menu/menu-errors.ts`
  and others) - a concurrent double-open on the same table re-reads and
  returns the winner's order instead of surfacing a raw DB error.
- Transfer's `reason` is optional per stories.yaml story 3 ("not one of
  CAP-8's six gated actions") but `audit_events.reason` is `NOT NULL` - a
  fixed placeholder string covers the no-reason case rather than making the
  column nullable for one caller.

## CAP-5 - Open and held orders (outlet-wide)

- **Intent:** staff sees every open/held order outlet-wide and resumes their
  own or takes over someone else's; taking over requires the same
  explicit-transfer action as CAP-2, never a silent switch.
- **Built** (`src/pos/orders/`, extending story 3/CAP-2's existing
  `OrdersService`/`PosOrdersController` - no new module):
  - `GET /pos/v1/outlets/:outletId/orders` - every non-`closed` `Order` in
    the outlet, table-tied or counter (`tableId: null`) alike. This is the
    outlet-wide complement to CAP-2's `GET .../table-map`, which only shows
    orders attached to a table and would never surface a future CAP-6
    counter order. Any staff member may view the list - viewing never
    requires ownership, same posture as `GET /orders/:orderId`.
  - Take-over is **not** a new mechanism: the response is plain `OrderView[]`
    (CAP-2's existing shape - `id`, `tenantId`, `outletId`, `tableId`,
    `ownerId`, `status`, timestamps), and a client takes over an order in
    this list by calling CAP-2's real `POST /pos/v1/orders/:orderId/transfer`
    directly. This story adds zero lines to `transfer()`/`updateStatus()`.
- **No OrderLine summary yet - reconciled decision, not an oversight.**
  pos/CAP-3 (order taking, issue #52) had not merged as of this story's
  build - `OrderLine` does not exist in the schema. SPEC.md does not require
  an item-count/running-total summary for this screen (P6), only the list
  plus resume/take-over actions, so this ships as plain `OrderView[]`.
  **TODO(pos/CAP-3, issue #52):** once `OrderLine` lands, extend
  `listOpenOrders()` in `src/pos/orders/orders.service.ts` (see the `TODO`
  comment directly above it) to fold in a per-order item-count/running-total
  summary, reading `OrderLine`'s real committed field names rather than
  guessing them now.
- **Ordering:** `orderBy: { createdAt: 'asc' }` - oldest-open-first, so an
  order that's been sitting longest surfaces first; same tie-break
  simplicity as CAP-2's table-map query.

### Test coverage (`test/pos-open-held-orders.e2e-spec.ts`, 6 tests, e2e
against a real Postgres test DB)

- Lists every open/sent order outlet-wide, including a counter order
  (`tableId: null`) that CAP-2's table-map would never show.
- Excludes closed orders.
- A take-over via CAP-2's real `POST /orders/:orderId/transfer` is reflected
  on the next read of this list (proves reuse, not a second ownership path).
- Any staff member can view the list, not only the order's owner.
- No session -> `401`; another tenant's outlet -> `404`.

## CAP-8 - Manager authorisation gate

- **Intent:** void-after-fire, comp, discount-above-threshold, price
  override, refund, and no-sale drawer-open each require a manager's PIN
  plus a mandatory reason code before they take effect, and each writes an
  `audit_events` row (actor, approver, both timestamps, reason) in the same
  transaction as the mutation it gates (AD-15, generalizing AD-6).
- **Built** (`src/platform/manager-auth.service.ts`, exported from the
  `src/platform` barrel per AD-2): one shared, callable `ManagerAuthService`
  every gated mutation calls into, instead of six reimplementations of the
  same PIN-check-plus-audit-row logic. No controller/route of its own - this
  story shipped it with no caller in this codebase yet (see "How to call
  this" below); pos/CAP-10's shift module (also this doc) is the first `/pos`
  HTTP surface to exist, but it does not call this service (shift open/close
  and cash movements are not among CAP-8's six gated actions). Registered as
  a `PlatformModule` provider, so any module that already imports
  `PlatformModule` (every module in this app does) gets it via constructor
  injection with no extra module wiring.

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

## CAP-10 - Shift open, cash management, and blind-count close

- **Intent:** a cashier opens a shift with a starting float, logs cash
  movements (paid-outs, bank drops) through the shift, and closes it with a
  blind cash count - the counted amount is entered before the system reveals
  the expected amount, and the resulting over/short lands on an immutable
  end-of-shift record.
- **Built** (`src/pos/shifts/`), all under `/pos/v1/shifts` - the first real
  `/pos` HTTP surface in this codebase:
  - `POST /` -> `{ outletId, floatMinor }` (201). Rejects a second open shift
    on the same outlet with 409 `shift_already_open` - checked up front for a
    clear message, and backed by a partial unique index
    (`shifts_one_open_per_outlet` on `outlet_id WHERE closed_at IS NULL`,
    see the migration) that is the actual guarantee under a concurrent
    double-open race; the service catches the resulting unique-violation and
    reports the same 409.
  - `GET /current?outletId=` - the outlet's currently open shift (404 if
    none), for a reloaded/rejoined session that doesn't already know the
    shift's id.
  - `GET /:id` - one shift by id (open or closed), 404 across tenants.
  - `POST /:id/cash-movements` -> `{ type: "paid_out"|"bank_drop",
    amountMinor, reason }` (201). 409 if the shift is already closed - a
    cash movement can only ever be logged against an open shift.
  - `POST /:id/close` -> `{ countedMinor }` (200). **The single atomic call**
    this story's blind-count rule depends on: `expectedMinor` and
    `overShortMinor` are computed and written in this same transaction,
    together with `closedAt`/`closedByStaffId` - never before this call,
    never by a separate endpoint. 409 to close an already-closed shift (the
    counted/expected/overShort trio, once written, is never overwritten -
    AD-14's insert-only-past-finalisation rule for this table).
  - Every mutating action re-verifies the pos session's staff id against a
    real, tenant-owned `StaffUser` row before writing anything under their
    name (`assertStaffInTenant` in `shifts.service.ts`) - defense in depth,
    since the pos guard only checks the JWT signature/audience and never
    touches the database (see the pos-realm stub note below).
- **Blind-count enforcement (AD-14, the load-bearing requirement):**
  `expectedMinor`/`overShortMinor` are `null` on every read of an open shift
  (`GET /current`, `GET /:id`, and the response of every
  `POST /:id/cash-movements` call) because the DB columns themselves are
  `null` until `close()` runs - there is no code path anywhere in this
  service that computes an expected figure ahead of a counted amount being
  supplied, and no "peek" endpoint exists. Proven directly in
  `test/shift-cash-management.e2e-spec.ts`'s "blind-count enforcement"
  suite, not just asserted.
- **Expected-amount formula is deliberately partial for this story:**
  `expectedMinor = floatMinor - sum(paid_out) - sum(bank_drop)`. `Order`/
  `Bill`/`Tender` don't exist anywhere in this codebase yet (greenfield
  alongside this story, per AD-14's table list - story 3/issue #46 builds
  `Order` independently). **TODO for the Bill & Settle story** (once
  `Order`/`Bill`/`Tender` land): fold in real cash-tender bill totals so the
  formula becomes `floatMinor + sum(cash-tender bill totals) -
  sum(paid_out) - sum(bank_drop)` - the one line to change is in
  `ShiftsService.closeShift()`.
- **Pos-realm auth - reconciled with pos/CAP-1 (issue #44).** This story was
  built before pos/CAP-1's real PIN login merged, so it originally shipped
  its own e2e-only stub of `src/platform/pos-jwt.ts`/`pos-auth.guard.ts`
  (tokens signed directly via `signPosToken` in tests, no real login). That
  reconciliation is now done automatically by rebasing onto `dev` after #44
  merged: this story's own commit never touched `pos-jwt.ts`/
  `pos-auth.guard.ts` (it only consumed `CurrentStaff`/`PosPrincipal`), so
  the real, merged implementation (`{ id: staffId, tenantId, outletId, name
  }`, signed by pos/CAP-1's real login/select-outlet endpoints) is what this
  story's `/pos/v1/shifts/*` routes run against - no code change was needed
  here, only this note.
- **Not gated by CAP-8's manager-authorisation service** - shift open/close
  and cash movements are not among the six actions AD-6/AD-15 name (only
  no-sale drawer-open, a distinct future action this story does not
  implement, is in the shift/cash domain). See "Key decisions" below.

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
- `shifts` (new, CAP-10) - `{ id, tenantId, outletId, openedByStaffId,
  floatMinor, openedAt, closedByStaffId?, closedAt?, countedMinor?,
  expectedMinor?, overShortMinor? }`. RLS `tenant_isolation` +
  `operator_read` (AD-5), same posture as every other tenant-owned table.
  `closedByStaffId`/`closedAt`/`countedMinor`/`expectedMinor`/
  `overShortMinor` are set together, exactly once, only by
  `ShiftsService.closeShift()` - nothing else in this codebase writes them,
  and there is no UPDATE path back to `null` once set. **One open shift per
  outlet at a time** is enforced by a partial unique index,
  `shifts_one_open_per_outlet` on `(outlet_id) WHERE closed_at IS NULL` -
  hand-written in the migration SQL, since Prisma's schema DSL has no
  partial-index syntax (same reason RLS policies live in migration SQL
  rather than `schema.prisma`).
- `cash_movements` (new, CAP-10) - `{ id, tenantId, shiftId, type (paid_out |
  bank_drop), amountMinor, reason, createdByStaffId, createdAt }`. RLS
  `tenant_isolation` + `operator_read`. Insert-only, like every other
  money-path row under AD-14 - there is no update/delete path for a logged
  movement anywhere in this service.
- Money is `bigint` minor units on both new CAP-10 tables (workspace
  convention); DTOs/views convert to/from plain JS `number` at the API
  boundary, same pattern as `item_prices.priceMinor` in the tenant-admin
  menu module.

## Integration points for later stories

- **For CAP-8's manager authorisation:** every gated mutation (order
  void-after-fire and comp, bill discount-above-threshold and price
  override, refund, shift no-sale drawer-open) calls
  `ManagerAuthService.authorize()` then `.recordApproval()` exactly as shown
  above - **never** a per-action PIN check or a second `audit_events` insert
  helper. None of those future call sites need to touch `Role.isManager` or
  `AuditEvent.approverId`/`approverName` directly - `ManagerAuthService` is
  the only reader/writer of those columns. If a future product decision
  wants a role beyond Owner/Manager to approve gated actions, flip that
  role's `isManager` to `true` (a data change) - `manager-auth.service.ts`
  needs no code change for that.
- **For CAP-10's shift & cash management: Bill & Settle** (issue not yet
  dispatched) - once `Order`/`Bill`/`Tender` exist, `ShiftsService.closeShift()`
  is the one place to add real cash-tender bill totals into the
  expected-amount formula - see the TODO comment right on that computation.
- **pos/CAP-1 (issue #44):** see CAP-10's "pos-realm auth is a stub" note
  above - this is the first thing to reconcile once that story lands; it
  also unblocks a real caller for CAP-8's `ManagerAuthService` (PIN-login
  needs no manager gate itself, but every screen built after it will).
- **pos/CAP-10's own no-sale drawer-open action** (not built by this story)
  is the natural first caller of `ManagerAuthService` from within the shift
  module, once it's dispatched.
- No pos capability besides the ones named above reads or writes
  `shifts`/`cash_movements`/`roles.is_manager`/`audit_events.approver_*` yet.

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
- CAP-8's own `manager-auth.service.ts` shipped no `/pos` HTTP module,
  controller, or DTO of its own - it is exactly AD-15's shared service and
  nothing else, with no caller in this codebase yet. (CAP-2 merged before
  CAP-1 did and, needing a guard to sit behind, temporarily stubbed its own
  copy of the pos realm; that stub has since been reconciled away in favour
  of CAP-1's real implementation - see "The pos auth realm" under CAP-2
  above. `manager-auth.service.ts` remains a plain service with no
  controller/route of its own - every future gated mutation calls into it
  directly, per "How to call this" above.)
- `ManagerGatedAction` is a closed TypeScript union (`MANAGER_GATED_ACTIONS`),
  not a free-text `string`, so the four future call sites get a compile-time
  guardrail against a typo silently producing an unrecognised `action` value
  in `audit_events`.
- `authorize()` does one dummy `argon2.verify` on every failure path (wrong
  PIN, non-manager PIN, or zero manager-capable staff), mirroring
  `OpsAuthService.dummyHash` (and CAP-1's own `PosAuthService.dummyHash` -
  same reasoning, applied independently) - so a caller can't learn from
  response timing whether a given tenant has any managers/staff at all.
- `setTenantContext` is duplicated per realm rather than imported across
  module boundaries - CAP-8 duplicated it into `manager-auth.service.ts`
  (that 3-line helper is already copy-pasted per admin submodule in this
  codebase, and `platform` must not import from `admin` regardless: `admin`
  already imports `platform`, so the reverse would be circular). CAP-10
  independently made the same call for the same reason, duplicating it into
  `src/pos/tenant-context.ts` rather than reaching into `src/admin/menu/`'s
  copy - AD-4's cross-realm-import rule (no reaching into another realm's
  module tree) extends to this backend module layout, not just restiq-web's
  route groups.
- One open shift per outlet, enforced both ways (pre-check for a clear
  error message, partial unique index for the actual race-safe guarantee) -
  the SPEC left the enforcement mechanism to the builder; a DB-level
  constraint is what "enforce it" has to mean once two terminals could
  plausibly race to open a shift for the same outlet at the same moment.
- `expectedMinor`/`countedMinor`/`overShortMinor` are nullable columns on
  the same `shifts` row (not a separate `EndOfShiftRecord` table) - the
  SPEC calls for "an immutable end-of-shift record", and a shift already
  has exactly one lifecycle (open -> closed) with exactly one close event;
  splitting it into a second table would need a 1:1 join for no isolation
  benefit, since the insert-only guarantee is enforced at the application
  layer (one write, in `closeShift()`, ever touches those columns) rather
  than by table boundaries.
- `CashMovement.reason` is a required plain string, not a reason-code enum -
  the SPEC's CAP-8 manager-authorisation actions (void, comp, discount,
  price override, refund, no-sale) use mandatory reason codes, but shift
  open/close and cash movements are explicitly *not* one of CAP-8's six
  gated actions (confirmed against AD-6/AD-15's binds lists, which name only
  the six) - so this story asks for a reason string, not a coded reason,
  and does not call the shared `platform/manager-auth` service or write an
  `audit_events` row for any CAP-10 action.
- **`PosPrincipal`'s real shape (`{ id, tenantId, outletId, name }`, settled
  by pos/CAP-1/issue #44) carries `outletId` on the token itself** - this
  story's own endpoints still take `outletId` explicitly in the request body
  /query rather than trusting the token's claim, since every shift action is
  already scoped through the shift's own stored `outletId` once one exists
  (`GET /current?outletId=`, `POST /`). No code change was needed here; this
  replaces an earlier note in this doc that guessed a narrower, no-`outletId`
  claim shape before #44 settled the real one.
- No manager-PIN gate on shift open/close or cash movements - per this
  story's dispatch notes, AD-6's mutation-and-audit reference binds CAP-8's
  six named actions, and shift/cash-management is not among them.
