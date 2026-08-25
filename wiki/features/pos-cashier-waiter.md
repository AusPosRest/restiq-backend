# POS Cashier & Waiter (Web Prototype) - backend

Backend for the `/pos` realm (AD-13): the online-only web prototype standing
in for the native Android POS/KDS build. See
`restiq-design/docs/specs/spec-pos-cashier-waiter/SPEC.md` for the full
capability set (CAP-1..11); this doc tracks what's actually built here,
story by story.

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

### The pos auth realm - stubbed ahead of pos/CAP-1

pos/CAP-1 (PIN login, issue #44) is what's supposed to stand up the `/pos`
realm and mint its tokens, and wasn't committed when this story started.
`src/platform/pos-jwt.ts` (`signPosToken`/`verifyPosToken`, `aud: "pos"`,
`POS_JWT_SECRET`) and `src/platform/pos-auth.guard.ts` (`PosAuthGuard`,
`CurrentStaff`) are a minimal stub of AD-13's realm - same disjoint-realm
pattern as `AdminAuthGuard`/`admin-jwt.ts` (AD-10), registered as a third
global `APP_GUARD` in `PlatformModule` alongside the ops and admin guards.
`PosPrincipal` is `{ id, tenantId, outletId, name }` - enough for this
story's ownership checks. **Reconcile once #44 merges:** the real PIN-login
endpoint should call `signPosToken()` from this file rather than re-deriving
its own signing logic, and the STUB NOTICE comment in `pos-jwt.ts` should be
deleted. If CAP-1 needs more principal fields, extend `PosPrincipal` there
rather than introducing a second pos JWT shape.

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

## Integration points for later stories

- pos/CAP-3 (order taking) and pos/CAP-4 (group ordering) extend this
  `Order` with `OrderLine` - the base shape (`id`, `tenantId`, `outletId`,
  `tableId`, `ownerId`, `status`, timestamps) is meant to be extended, not
  replaced. Read the exact field names above before adding `OrderLine`.
- pos/CAP-5 (open/held orders) lists exactly the rows this story already
  writes - no new listing logic needed beyond a tenant/outlet-scoped
  `findMany`.
- pos/CAP-6 (QSR counter) is the first caller that creates an `Order` with
  `tableId: null`.
- pos/CAP-7 (bill & settle) is what finally makes `status: 'closed'` mean
  something (today it's just a terminal status with no side effects) and is
  what the table map's `needs-bill` TODO depends on.
- pos/CAP-1 (PIN login, issue #44) replaces the stubbed pos-jwt/pos-auth
  guard's token minting - see "The pos auth realm" above.

## Key decisions

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
