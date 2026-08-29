# Customer QR Self-Order (Guest Mobile Web) - backend

## Capabilities

- **CAP-1** QR entry and table session - a guest scans the table QR and
  reaches the outlet's menu with no app or account; the first guest starts
  the session (name+phone), later guests join with its 4-digit PIN. A
  session binds to exactly one table; a wrong PIN cannot join; an outlet
  with `qr_ordering` disabled is refused server-side.
- **CAP-2** Menu browse and item detail - a guest reads a projection of the
  real catalogue scoped to their own outlet: categories, items, current
  prices (real pricing resolution), variants, modifier groups (min/max),
  allergens, and an `available` flag that reflects the tenant-wide 86 toggle
  plus any per-outlet override. An 86'd item is included, marked
  unavailable - never omitted. **Schema gap** (see Key decisions below): no
  photos, no bilingual (Hindi) names, no veg/non-veg marker exist on
  `MenuItem` today, so this projection can't expose them yet.
- **CAP-3** Shared group cart - every guest in the session adds to one
  shared table cart, each item attributed to the guest who added it; any
  guest can view the whole table's cart grouped by guest with per-guest and
  combined totals; only the guest who added a line may edit or remove it.
- **CAP-4** Order placement into the real pipeline - placing the table order
  converts the session's shared cart into a real `Order`/`OrderLine` set,
  marked with its `qr` source and per-guest labels, fired to the kitchen
  through the same transition staff orders use. The placed order appears in
  the POS open-orders list and lands on the KDS as tickets carrying guest
  labels - never a parallel guest-only order model (AD-18).
- **CAP-6** Order status tracking - a guest polls a server-derived stepper
  (Placed/Accepted/Preparing/Ready) for one order, or lists every order the
  table session has placed, each with its own stepper - see "Key decisions"
  for the honest mapping off the real ticket lifecycle.

## What's built

- The **fifth disjoint auth realm** (AD-17), same pattern as AD-3/AD-10/AD-13:
  own audience (`guest`), own secret `GUEST_JWT_SECRET`, own global guard
  gating `/guest(/|$)` routes only.
  - `src/platform/guest-jwt.ts` - `signGuestToken`/`verifyGuestToken`,
    `GuestPrincipal { id, sessionId, tenantId, outletId, tableId, name }`.
  - `src/platform/guest-auth.guard.ts` - `GuestAuthGuard` (registered as a
    fourth `APP_GUARD` in `platform.module.ts`) + `CurrentGuest` decorator.
  - The principal is minted only from a `TableSession` start/join - never an
    account, never a password.
- Greenfield `TableSession`/`Guest` models (`prisma/schema.prisma`,
  migration `20260829055809_guest_realm_table_sessions`):
  - `TableSession`: `tenantId`/`outletId`/`tableId` (reuses the real
    `DiningTable` model, no second table model), `status`
    (`open`/`settled`/`closed`), plain-stored 4-digit `sessionPin`
    (deliberately **not** argon2-hashed - see the schema comment citing
    SPEC-qr-self-order's Constraints and AD-17: it gates joining a shared
    cart, not money or an account), `startedByGuestName`/
    `startedByGuestPhone`, `expiresAt` (idle-TTL backstop, ~4h). Exactly one
    open session per table, enforced by the
    `table_sessions_one_open_per_table` partial unique index (same
    convention as `shifts_one_open_per_outlet`).
  - `Guest`: one row per joined guest (`sessionId`, `name`, `phone?`,
    `joinedAt`) - the first guest's phone is captured at start; later
    joiners give name only.
  - RLS (AD-5): standard `tenant_isolation`/`operator_read` on both tables.
  - A new `guest_entry_read` SELECT-only policy on `outlets` and
    `dining_tables`, gated by `app.guest_entry_context = 'guest'` - lets a
    pre-auth guest request resolve which tenant owns a scanned outlet+table
    pair (the QR carries no tenant id) before `app.tenant_id` is known, the
    same chicken-and-egg `admin/auth.service.ts`'s `acceptInvite` already
    solves for `owner_invites` (`invite_accept_read`). Never widens
    INSERT/UPDATE/DELETE.
- `src/guest/` module (`GuestModule`, exported via `src/guest/index.ts`):
  - `sessions/sessions.service.ts` (`GuestSessionsService`) - start, join,
    the authenticated session view, the CAP-1 capability gate
    (`assertQrOrderingEnabled`, reading the real `OutletCapability` row,
    key `qr_ordering` - absent row = disabled), and
    `closeSessionForStaff` (consumed by pos, see below).
  - `sessions/sessions.controller.ts` -
    `GET /guest/v1/outlets/:outletId/availability` (public),
    `POST /guest/v1/sessions` (public, start), `POST /guest/v1/sessions/join`
    (public, join), `GET /guest/v1/session` (authenticated, current session
    view).
  - `sessions/join-lockout.ts` - in-memory rate limit on wrong PIN guesses,
    5 attempts/30s per `(outletId, tableId)`, same convention as
    `pos/auth/lockout.ts`.
- `src/pos/tables/tables.controller.ts` -
  `POST /pos/v1/tables/:tableId/close-session` (pos realm) - staff-side
  close per lifecycle, delegating to `GuestSessionsService.closeSessionForStaff`
  through the guest module's barrel (AD-2: no second close-a-session
  implementation).
- `src/guest/menu/` (story 2, issue #71) - `GuestMenuService`/
  `GuestMenuController`, both registered in `GuestModule`:
  - `menu.service.ts` - reads the real catalogue
    (`MenuCategory`/`MenuItem`/`ItemVariant`/`ModifierGroup`/`Modifier`/
    `Allergen`/`ItemOutletOverride`, all from `admin/menu`) scoped to
    `guest.tenantId`, with per-item/variant price resolved through
    `resolveCurrentPrice` (imported from the `admin` barrel, channel `qr`,
    outlet = `guest.outletId`) - the exact same resolution
    `pos/orders/order-lines.service.ts` uses for POS lines, never
    re-derived. Availability = the outlet's `ItemOutletOverride` row if one
    exists (authoritative), else the item's tenant-wide `available` flag.
  - `menu.controller.ts` - both routes require a guest token (no
    `@Public()` - the outlet comes from the principal, not a client param).

## Endpoint contracts (story 2, guest menu)

- `GET /guest/v1/menu` (guest token) -> 200 `GuestMenuView`:
  ```ts
  interface GuestMenuView {
    outletId: string
    categories: {
      id: string; name: string; sortOrder: number
      items: {
        id: string; categoryId: string; name: string; shortName: string
        available: boolean          // tenant `available` AND/OR outlet override, override wins if present
        priceMinor: number | null   // null when the item has variants (price lives on each variant instead) or is genuinely unpriced
        currency: string | null
        variants: { id: string; name: string; sortOrder: number; priceMinor: number | null; currency: string | null }[]
        modifierGroups: { id: string; name: string; minSelections: number; maxSelections: number; modifiers: { id: string; name: string; priceMinor: number }[] }[]
        allergens: { id: string; name: string }[]
      }[]
    }[]
  }
  ```
- `GET /guest/v1/menu/items/:itemId` (guest token) -> 200, one `MenuItemView`
  (the same item shape as above, addressed directly - added so the Q4 Item
  Detail screen doesn't have to re-fetch the whole menu just to open one
  item). 404 `not_found` for a missing item or one belonging to another
  tenant (never leaks tenant existence).
- Both routes: 401 `unauthorized` without a valid guest token, or with any
  other realm's token (same guard as every other `/guest` route, AD-17).
- **CAP-3 shared group cart** (issue #72, `src/guest/cart/`):
  - Greenfield `CartLine`/`CartLineModifier` models (migration
    `20260829063149_guest_cart_lines`) - session state, **not** an Order (the
    real `Order`/`OrderLine` set is only created at placement, CAP-4/story
    4). `CartLine` snapshots the adding guest's id+name at add-time
    (`guestId`/`guestName`) so the shape converts cleanly into an `Order`'s
    per-guest labels later, but deliberately does **not** snapshot price -
    unlike `OrderLine.unitPriceMinor`, price is resolved live at read time
    against `item_prices` (AD-11 already makes that table insert-only and
    re-resolvable; nothing is final until placement snapshots it for real).
  - `cart/cart.service.ts` (`CartService`) - add/update/remove a line and the
    combined cart read, all scoped to the caller's `GuestPrincipal.sessionId`
    inside the session's tenant RLS context. Reuses
    `admin/menu/pricing.ts`'s `resolveCurrentPrice` (via the admin module's
    barrel, same reuse `pos/orders/order-lines.service.ts` already
    established) against the guest-specific `PriceChannel.qr` price channel.
  - Item-availability and modifier min/max validation **mirror**
    `pos/orders/order-lines.service.ts`'s rules exactly (same SPEC-mandated
    server-side check) - duplicated per this workspace's convention of
    small, module-local helpers rather than a cross-module import of a
    pos-internal, non-exported function (AD-2). 86'd-item rejection checks
    both the tenant-wide `MenuItem.available` toggle and this outlet's
    `ItemOutletOverride`, the same two sources Tenant Admin's
    `items.service.ts` writes.
  - Ownership: any guest may view the whole cart; only the guest who added a
    line (`CartLine.guestId === GuestPrincipal.id`) may `PATCH`/`DELETE` it -
    403 `forbidden` otherwise.
  - Closed/settled session -> 410 `session_closed` on every cart call,
    reusing `sessions.service.ts`'s `isSessionInactive` (exported for this,
    same guest module, not a cross-module reach).
  - `cart/cart.controller.ts` - `GET /guest/v1/cart`,
    `POST /guest/v1/cart/lines`, `PATCH /guest/v1/cart/lines/:id`,
    `DELETE /guest/v1/cart/lines/:id` (all guest-token authenticated).
- **CAP-4 order placement** (story 4, issue #77, `src/guest/orders/`) -
  `GuestOrdersService`/`GuestOrdersController`, registered in `GuestModule`
  (which now also imports `KitchenModule` for the fire hook - no cycle,
  since `KitchenModule` itself only imports `PlatformModule`):
  - `orders.service.ts`'s `placeOrder` runs one transaction: loads the
    active session (410 `session_closed` if inactive), reads the session's
    `CartLine`s (400 `empty_cart` if none), auto-assigns a seat number per
    distinct guest by join order (guest 1 = seat 1, guest 2 = seat 2, ...) so
    every created `OrderLine` satisfies pos/CAP-4's all-lines-seated fire
    gate by construction, creates the `Order` (`source: 'qr'`, `sessionId`
    set, `ownerId: null`) and each `OrderLine` (price re-resolved via the
    same `resolveCurrentPrice`/`qr`-channel read the cart uses, `guestId`/
    `guestName` carried straight from the `CartLine`, `addedByStaffId:
    null`), transitions the order `open -> sent`, and calls
    `KitchenTicketsService.fireOnSend` - the exact function
    `pos/orders/orders.service.ts`'s `updateStatus` calls for a staff order,
    in the same transaction (AD-16/AD-18: one fire implementation, one
    ticket domain). Deletes the session's `CartLine`s on success
    (`CartLineModifier` rows cascade at the DB level).
  - Builds the `Order`/`OrderLine` rows directly against Prisma rather than
    calling into `pos/orders`'s `OrdersService`/`OrderLinesService`: those
    are staff-gated (`PosPrincipal`, `assertOwner`), and `pos`'s own barrel
    (`src/pos/index.ts`) exports only `PosModule` - reaching their internals
    would mean either a faked staff principal or a `pos`<->`guest` module
    cycle (`pos.module.ts` already imports `GuestModule` for the staff-side
    session close). The one piece of `pos/orders`' machinery genuinely
    reused is the kitchen fire hook itself, which has no such dependency.
  - `orders.controller.ts` - `POST /guest/v1/orders` (guest token, no body).
- **CAP-6 order status tracking** (story 6, issue #81, `src/guest/orders/`,
  no schema change - pure read off `Order`/`Ticket`):
  - `orders.service.ts`'s `buildOrderStatusView` is the one place the
    placed/accepted/preparing/ready mapping lives - see "Key decisions" below
    for why `accepted` and `preparing` reach at the same instant in this
    model, and why that is documented rather than papered over with an
    invented "started cooking" heuristic.
  - `getOrderStatus(guest, orderId)` - loads the caller's active session
    (410 `session_closed` if inactive), then the order (404 `not_found` if
    it doesn't exist, isn't this tenant's, or isn't this session's - the
    three cases collapse into one response so a guest token can never be
    used to probe for another table's order ids), reads that order's
    `Ticket`s, and derives the view.
  - `listSessionOrders(guest)` - same active-session check, then every
    `Order` with `sessionId` = the caller's session, each with its own
    derived view (a table can place more than one order in a session, e.g.
    a second round after the first is closed - `orders_one_active_per_table`
    only limits one *open/sent* order per table at a time, not per session).
  - `orders.controller.ts` (now `@Controller('guest/v1')`, not
    `guest/v1/orders`, so it can also own the `session/orders` route) -
    `GET /guest/v1/orders/:orderId/status`, `GET /guest/v1/session/orders`
    (both guest-token authenticated).

## Endpoint contracts

- `GET /guest/v1/outlets/:outletId/availability` -> `{ available: boolean, reason?: 'not_found' | 'qr_ordering_disabled' }`.
- `POST /guest/v1/sessions` `{ outletId, tableId, name, phone }` -> 201
  `{ token, pin, session: TableSessionView }`; 409 `session_already_open` if
  the table already has an open session; 403 `qr_ordering_disabled`; 404
  `not_found` for an unknown outlet/table pair.
- `POST /guest/v1/sessions/join` `{ outletId, tableId, pin, name }` -> 200
  `{ token, session: TableSessionView }`; 403 `invalid_pin`; 429
  `locked_out` after 5 wrong guesses in 30s; 404 `no_open_session`.
- `GET /guest/v1/session` (guest token) -> 200 `TableSessionView`; 410
  `session_closed` once staff-closed/settled/idle-expired.
- `POST /pos/v1/tables/:tableId/close-session` (pos token) -> 200
  `{ closed: true }`; 404 `no_open_session`.
- `TableSessionView`: `{ sessionId, status, table: { id, label }, outletId, guests: [{ id, name, joinedAt }], createdAt, expiresAt, closedAt }`.
- `GuestPrincipal` (JWT payload, `aud: "guest"`):
  `{ id, sessionId, tenantId, outletId, tableId, name }`.
- `GET /guest/v1/cart` (guest token) -> 200 `TableCartView`; 410
  `session_closed` once the session is closed/settled/idle-expired.
- `POST /guest/v1/cart/lines` `{ itemId, variantId?, quantity, modifierIds? }`
  -> 201 `TableCartView`; 400 `validation_failed` (unknown item/variant/
  modifier), 400 `modifier_selection_invalid` (min/max violation), 400
  `item_unavailable` (86'd tenant-wide or for this outlet); 410
  `session_closed`.
- `PATCH /guest/v1/cart/lines/:id` `{ quantity?, modifierIds? }` -> 200
  `TableCartView`; 403 `forbidden` if the caller isn't the line's own guest;
  404 `not_found`; 410 `session_closed`.
- `DELETE /guest/v1/cart/lines/:id` -> 200 `TableCartView`; 403 `forbidden`;
  404 `not_found`; 410 `session_closed`.
- `TableCartView`: `{ sessionId, guests: GuestCartView[], totalMinor, currency }`.
- `GuestCartView`: `{ guestId, guestName, lines: CartLineView[], subtotalMinor }`.
- `POST /guest/v1/orders` (guest token, no body) -> 201 `PlacedOrderView`;
  400 `empty_cart` (nothing in the session's cart); 400 `no_price` (an
  item's price disappeared between cart-add and placement); 410
  `session_closed`.
- `PlacedOrderView`: `{ orderId, tableId, status: 'sent', source: 'qr', sessionId, lines: PlacedOrderLineView[] }`.
- `PlacedOrderLineView`: `{ id, itemId, itemName, variantId, variantName, quantity, unitPriceMinor, seatNumber, guestId, guestName, modifiers: [{ id, name, priceMinor }] }`
  (`unitPriceMinor`/`modifiers[].priceMinor` are real snapshots now, taken at
  placement - unlike `CartLineView`'s live-resolved figures).
- `CartLineView`: `{ id, guestId, guestName, itemId, itemName, variantId, variantName, quantity, unitPriceMinor, modifiers: [{ id, name, priceMinor }], lineTotalMinor, createdAt }`
  (`unitPriceMinor`/`modifiers[].priceMinor` are resolved live, never
  snapshotted; `lineTotalMinor = (unitPriceMinor + sum(modifiers.priceMinor)) * quantity`).
- `GET /guest/v1/orders/:orderId/status` (guest token) -> 200
  `GuestOrderStatusView`; 404 `not_found` (unknown order, another tenant's,
  or another session's - all three collapse to the same response); 410
  `session_closed` once the caller's session is closed/settled/idle-expired.
- `GET /guest/v1/session/orders` (guest token) -> 200
  `GuestSessionOrdersView`; 410 `session_closed`.
- `GuestOrderStatusView`: `{ orderId, tableId: string | null, step: GuestOrderStep, steps: GuestOrderStepView[] }`.
- `GuestSessionOrdersView`: `{ sessionId, orders: GuestOrderStatusView[] }`.
- `GuestOrderStep`: `'placed' | 'accepted' | 'preparing' | 'ready'`.
- `GuestOrderStepView`: `{ step: GuestOrderStep, reachedAt: string | null }` -
  `steps` always lists all four, in order, `reachedAt` null for any not yet
  reached; `step` is the furthest one reached (what the stepper highlights).

## Integration points for later stories

- Story 2 (menu browse) reads `CurrentGuest()`'s `GuestPrincipal` for
  `tenantId`/`outletId`/`tableId`/`sessionId` scoping - no second
  guest-identity lookup, same as CAP-3's cart does.
- Story 4 (order placement, **done**) converts each `CartLine` into a real
  `OrderLine`: `CartLine.guestId`/`guestName` mapped directly onto the
  per-guest label fields added to `OrderLine`, `CartLine.itemId`/
  `variantId`/`quantity`/selected modifier ids carried over as-is - the
  cart's shape needed no reshaping, exactly as planned. Price is
  re-resolved and snapshotted for real at that point (`resolveCurrentPrice`
  read again, same as `pos/orders/order-lines.service.ts` does today).
- Story 5 (checkout) settles the session (`status: 'settled'`) instead of
  `closed` - a separate terminal state already modeled.
- Story 3 (shared cart, built concurrently in a sibling worktree/issue) will
  read item/variant/modifier ids and prices off this same `GuestMenuView`
  shape when a guest adds to the cart - no new pricing or availability logic
  needed there, only cart-state bookkeeping.
  `closed` - a separate terminal state already modeled. Once a session
  settles or closes, its `CartLine`s are no longer reachable (410 on every
  cart call) - they are already superseded by the real `Order` created at
  placement.

## Key decisions

- Session PIN is plain-stored, not argon2 - SPEC-qr-self-order's Constraints
  section and AD-17 both call this out explicitly: it protects against
  joining the wrong table's cart, not money or an account, so it is
  rate-limited instead of credential-grade. Do not "fix" this to argon2.
- The QR entry gate is enforced server-side on every entry point (start,
  join), never just the availability-check endpoint - a disabled/absent
  `OutletCapability` row is checked inside the same transaction that would
  create the session or the guest row.
- `guest_entry_read` is a narrow, additional permissive RLS policy (Postgres
  ORs multiple permissive policies together) - it only ever widens SELECT on
  `outlets`/`dining_tables`, proven in `test/rls.e2e-spec.ts` against a
  restricted, non-superuser probe role.
- **Schema-vs-SPEC gap, reported honestly (story 2):** SPEC-qr-self-order's
  CAP-2 and stories.yaml story 2 both want photos, veg/non-veg markers, and
  bilingual (English/Hindi) item names on the guest menu. The real
  `MenuItem` model (`prisma/schema.prisma`) carries none of those columns -
  only `id`/`name`/`shortName`/`available`/`stationId`. `GuestMenuView`
  exposes exactly what the schema has and omits the rest rather than
  inventing fields; adding photo/bilingual-name/veg columns is a menu-schema
  change for a future story (would touch `admin/menu` first, since that's
  the one schema owner), not something story 2 fabricates.
- Combos (`Combo`/`ComboComponent`) are out of scope for this projection -
  neither the SPEC's CAP-2 text nor stories.yaml story 2 mention them, so
  the ponytail ladder says skip until a story actually asks for them.
- The guest menu deliberately makes one `resolveCurrentPrice` call per
  item/variant inside the same transaction (N+1, not batched) - it mirrors
  the exact per-line resolution `pos/orders/order-lines.service.ts` already
  uses, and the admin barrel exports only the tx-scoped function, not the
  underlying pure `pickCurrentPrice` (AD-2: cross-module reach only through
  a module's own barrel). Acceptable for a single-outlet menu's item count;
  revisit only if it becomes a real bottleneck.
- `CartLine` is greenfield, deliberately not an `Order`/`OrderLine` - the
  cart is transient session state that may never be placed (a table can
  close without ordering); an `Order` is created only once, at placement
  (CAP-4), from the cart's contents.
- Price is resolved live on every cart read, not snapshotted on add -
  `item_prices` is already insert-only and cheaply re-resolvable (AD-11), so
  snapshotting twice (once into the cart, again at placement) would just be
  a second place for the two numbers to drift apart before there is any
  reason for either to be authoritative yet.
- The cart's item-availability/modifier-min-max rules are a deliberate
  duplication of `pos/orders/order-lines.service.ts`'s private helpers, not
  a shared import - AD-2 restricts cross-module reach to a module's public
  barrel, and those helpers aren't (and shouldn't become) part of the pos
  module's public surface just to serve one other caller.
- **`Order.ownerId` and `OrderLine.addedByStaffId` are now nullable**
  (story 4, issue #77) - a guest-placed order genuinely has no staff owner
  or adder at creation. The alternative (assigning the outlet's first/any
  staff row as a placeholder owner) would misrepresent who opened the
  order and was rejected explicitly. `assertOwner()`
  (`pos/orders/orders.service.ts`) treats `null` as unclaimed: any staff may
  mutate the order, or take explicit ownership via the existing `transfer()`
  action - no new mechanic, no PIN/reason requirement beyond what
  `transfer()` already has. Every pre-existing and staff-created row is
  unaffected (`ON DELETE`/`NOT NULL` semantics for real staff ids are
  unchanged; only the column itself became optional).
- **Seat numbers are auto-assigned by guest join order, not a real
  "seat"** - pos/CAP-4's all-lines-seated fire gate
  (`orders.service.ts`'s `assertAllLinesSeated`) blocks the open->sent
  transition while any `OrderLine.seatNumber` is null. A guest table order
  has no staff-driven seat-assignment step, so `placeOrder` assigns each
  distinct guest in the session one seat number, in `joinedAt` order (first
  guest = seat 1, second = seat 2, ...), and every line inherits its adding
  guest's seat. This satisfies the gate by construction; "seat" here reads
  as "which guest ordered this," not a physical chair number - a documented
  scope decision, not a re-derivation of the pos concept.
- Placement builds the `Order`/`OrderLine` rows directly against Prisma
  rather than calling `pos/orders`'s `OrdersService`/`OrderLinesService` -
  those are staff-gated (`PosPrincipal`, `assertOwner`) and `pos`'s barrel
  (`src/pos/index.ts`) exports only `PosModule`, not those services.
  Reusing them would mean either faking a staff principal (rejected above)
  or a `pos`<->`guest` module cycle, since `pos.module.ts` already imports
  `GuestModule` for the staff-side session close. The genuinely shared piece
  - the kitchen fire hook - has no such dependency and is injected the same
  way `pos/orders` does, so AD-16/AD-18's "one fire implementation" holds
  without a cycle.
- `KitchenTicketsService.TicketLineView` gained a `guestName` field
  (`kitchen/tickets.dtos.ts`), populated straight from
  `OrderLine.guestName` - additive, so every existing KDS consumer is
  unaffected; K1's QR-group-order variant reads it to render per-guest
  labels on a shared-table ticket.
- Placing an order deletes the session's `CartLine`s rather than adding a
  "consumed" flag - no schema exists for one, and once an `Order` exists the
  cart that produced it has no further purpose (a guest could, in
  principle, start a fresh cart afterwards for the same still-open session;
  nothing in CAP-4's scope needs to prevent that).
- **CAP-6's step mapping is deliberately honest about what the real ticket
  model can and can't distinguish** (story 6, issue #81). The kitchen ticket
  domain (`src/kitchen`) only tracks `queued -> bumped` - there is no
  "started cooking" state - so the mapping is:
  - `placed` - the order exists; reached at `Order.createdAt`. Always
    reached the moment an order is returned to the guest, since placement
    (CAP-4) creates the order synchronously.
  - `accepted` - the kitchen has it; reached once at least one `Ticket` has
    fired (`fireOnSend`/`fireAddedLine` ran), at the earliest `firedAt`
    across the order's tickets.
  - `preparing` - **reaches at the exact same instant as `accepted`** (the
    same earliest `firedAt`). The ticket model has no independently
    observable "now actually being cooked" signal separate from "the
    kitchen has fired it," so a fired ticket IS being prepared in this
    model - claiming otherwise would require inventing a heuristic (e.g. an
    elapsed-time guess), which SPEC-qr-self-order's CAP-6 success criterion
    explicitly forbids ("the stepper never shows a state the ticket data
    doesn't support"). This was decided over two rejected alternatives: (a)
    inventing a time-in-queue threshold to fake a "preparing" transition -
    rejected, it would be product fiction presented as real kitchen state;
    (b) never reporting `preparing` as reached until `ready` - rejected, it
    would make the guest-visible stepper regress to only three usable
    states, which is a worse guest experience than an honestly-documented
    collapse.
  - `ready` - reached only once **every** one of the order's tickets is
    bumped, at the latest `bumpedAt` among them (mirrors CAP-6's own
    constraint: "Ready = all tickets bumped").
  - The response's top-level `step` (what the UI highlights as current) is
    what actually distinguishes `accepted` from `preparing` in practice: it
    reports `'placed'` with no tickets yet, `'preparing'` once tickets exist
    but not all are bumped (i.e. strictly further along than merely
    "accepted"), and `'ready'` once all are bumped - `'accepted'` is
    reachable as a `steps[]` entry (its `reachedAt`) but is never itself
    reported as the current `step`, since by the time any ticket exists this
    model already considers the order "preparing."
  - Because a guest order is always fired synchronously at placement
    (CAP-4's `placeOrder` transitions `open -> sent` and fires tickets in
    the same transaction), a freshly-placed order's very first status read
    is already `'preparing'`, not `'accepted'` - there is no observable
    window where a real guest order sits at `'accepted'` only. This is
    called out explicitly rather than left as a surprising gap: it is a
    consequence of CAP-4's synchronous-fire design, not a bug in CAP-6's
    mapping.
  - `getOrderStatus`/`listSessionOrders` both require the caller's session
    to be active (410 `session_closed` otherwise) and the order to belong to
    that same session (never merely the same tenant) - a guest can watch
    their own table's orders, never another table's, even within the same
    tenant/outlet.
