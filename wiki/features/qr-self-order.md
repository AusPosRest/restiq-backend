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
- `CartLineView`: `{ id, guestId, guestName, itemId, itemName, variantId, variantName, quantity, unitPriceMinor, modifiers: [{ id, name, priceMinor }], lineTotalMinor, createdAt }`
  (`unitPriceMinor`/`modifiers[].priceMinor` are resolved live, never
  snapshotted; `lineTotalMinor = (unitPriceMinor + sum(modifiers.priceMinor)) * quantity`).

## Integration points for later stories

- Story 2 (menu browse) reads `CurrentGuest()`'s `GuestPrincipal` for
  `tenantId`/`outletId`/`tableId`/`sessionId` scoping - no second
  guest-identity lookup, same as CAP-3's cart does.
- Story 4 (order placement) converts each `CartLine` into a real `OrderLine`:
  `CartLine.guestId`/`guestName` map directly onto the per-guest label
  fields that story adds to `OrderLine`, and `CartLine.itemId`/`variantId`/
  `quantity`/selected modifier ids carry over as-is - the cart's shape was
  chosen so this conversion needs no reshaping. Price gets snapshotted for
  real at that point (`resolveCurrentPrice` read again, same as
  `pos/orders/order-lines.service.ts` does today).
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
