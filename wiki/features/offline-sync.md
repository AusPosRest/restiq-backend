# Offline sync for the Windows hub till - backend

Design: Restiq `docs/SYNC-DESIGN.md` (accepted 2026-10-07). Issue restiq-backend#185.

## Capabilities

- **D15** Offline-first selling - one hub till per outlet sells offline and catches the cloud up; the cloud owns menu, prices, staff and floor plan, the hub owns sales.

## What's built

- **Device key at enrolment** - `POST /device/v1/enroll` takes optional `publicKey` (base64 SPKI DER, ed25519), checked before the code is used up - `src/ops/devices/devices.service.ts`.
- **Device realm** - `/sync/v1/*` is signed, not token-authenticated: headers `X-Device-Id`, `X-Device-Timestamp` (ms), `X-Device-Signature` (base64 ed25519 over `METHOD\npath?query\ntimestamp\nsha256hex(raw body)`), 5-minute skew. 401 `invalid_signature` for any failure, 403 `device_revoked` / `device_not_in_outlet` / `tenant_inactive` - `src/platform/device-sync.guard.ts`, `device-signature.ts`. `main.ts` keeps the raw body for this.
- **Change feed** - `sync_changes` (bigserial id = cursor), written by the `sync_record_change()` trigger on the 21 cloud-owned tables - migrations `20261113180000_offline_sync`, `20261113200000_sync_tenant_brand_feed` (adds `tenants` and `brands`, #292). Pruned daily to 30 days (`SyncService.prune`, skipped when `RESTIQ_HUB=1` or in tests); each tenant's newest change is always kept.
- **Hub only** (#292) - `bootstrap` and `push` answer 403 `not_hub` unless the device's `role` is `hub` (ops designates it). Pull, session status, heartbeat and rejections stay open to any keyed device in the outlet.
- `GET /sync/v1/bootstrap` - every cloud-owned row (including the caller's own `tenants` row and its `brands`) for the device's tenant and outlet as plain rows (database column names), the role permission catalogue, `policy` (`maxOfflineHours` from `tenants.max_offline_hours`, default 24; `syncIntervalSeconds` 30) and a cursor - `src/pos/sync/sync.service.ts`.
- `GET /sync/v1/pull?cursor=&limit=` - rows changed after the cursor, latest per row, read as they are now (`delete` when gone). A cursor above 0 but below the tenant's oldest kept change answers 410 `cursor_expired`: bootstrap again.
- `POST /sync/v1/heartbeat` (#292) - `{outboxDepth, appVersion, clockSkewSeconds, recentRejectionCount}` (same DTO and same device columns as the ops heartbeat, via `heartbeatData()`), 204; `GET /ops/v1/sync-health` shows the values.
- `POST /sync/v1/push` - see below - `src/pos/sync/sync-push.service.ts`.
- `GET /sync/v1/session-status` (with `isHub`), `GET /sync/v1/rejections`, `POST /sync/v1/rejections/:opId/acknowledge`.

### Push

Body `{batchId, ops[1..200]}` (201+ → 413 `batch_too_large`). Each op `{opId, seq, type, at, actorStaffId, payload}`. Result per op: `accepted`, `duplicate` (opId already in the AD-7 `applied_ops` ledger), `rejected` (with `code`, kept in `sync_dead_letters`), or `deferred` (`seq_gap`: seq is not `lastAppliedSeq + 1`, so this op and the rest wait for the missing one).

| type | payload | online equivalent |
|---|---|---|
| `order.create` | `orderId`, and `tableId` or `tokenNumber` (counter order keeps the hub's token) | open table / counter order |
| `order.line.add` | `orderId`, `lineId`, `itemId`, `variantId?`, `quantity`, `modifierIds?`, `seatNumber?`, `note?`, `unitPriceMinor` (string), `modifierPriceMinor?` (`{modifierId: string}`) | add line - at the hub's price, not today's |
| `order.line.update` | `orderId`, `lineId`, plus the update fields | update line |
| `order.line.remove` | `orderId`, `lineId` | remove line |
| `order.status` | `orderId`, `status` | status change (fires kitchen tickets on `sent`) |
| `bill.create` | `orderId`, `billId` | create bill |
| `bill.finalize` | `billId`, `tenders`, `tenderIds` (one per tender), `discountMinor?`, `discountReason?` | finalize |
| `order.combo.add` (#297) | `orderId`, `lineId` (parent), `comboId`, `quantity`, `unitPriceMinor`, `seatNumber?`, `children[]` of `{lineId, itemId, variantId?, quantity (whole line), unitPriceMinor, modifierPriceMinor?}` | add combo - the hub's lines and prices as written; slots and availability are not re-checked |
| `order.line.void` (#297) | `orderId`, `lineId`, `reason`, `approvedByStaffId` | void after fire - no PIN; audited `sync.void_approved_offline` with the approver |
| `order.transfer` (#297) | `orderId`, `newOwnerStaffId`, `reason?` | transfer |
| `order.discard` (#297) | `orderId` | discard empty order |
| `shift.open` (#297) | `shiftId`, `outletId` (must be the hub's), `floatMinor` | open shift |
| `shift.cash_movement` (#297) | `shiftId`, `movementId`, `type`, `amountMinor`, `reason` | paid out / bank drop |
| `shift.close` (#297) | `shiftId`, `countedMinor` | blind close |
| `clock.in` (#297) | `clockEventId` | clock-in written at PIN login (skipped if the cloud already has one that local day) |
| `clock.out` (#297) | `clockEventId` | clock out - kept even if the cloud never saw the clock-in |
| `ticket.bump` (#297) | `orderId`, `stationId` (uuid or `null` = unrouted) | bump the order's queued ticket at that station |
| `ticket.recall` (#297) | `orderId`, `stationId` (uuid or `null`) | recall the ticket there bumped last; the 12 h window is not re-checked |

Ids made on the hub are kept, and `at` becomes the row's business time (`createdAt`, `finalizedAt`, `voidedAt`, `openedAt`/`closedAt`, `occurredAt`, `bumpedAt`/`recalledAt`). Clock ops need no permission; shift ops need `settle_bills`, ticket ops `fire_kitchen`, the rest `take_orders`. Refunds stay cloud-only (D-1) and ticket refire stays on the hub - neither is an op. The payload classes are exported from `src/pos` (`Sync*Payload`) so the hub's op recorder validates against the same rules.

## Integration points for later stories

- Desktop hub (restiq-desktop): bootstrap into its local store, outbox → push, pull every `syncIntervalSeconds`, lock when `mustSyncBefore` passes.
- Per-device bill number series waits on decision O5; bills are still numbered by the cloud at finalize.
- Ops dead-letter replay of sync ops (payload is not stored, by NFR-15).

## Key decisions

- **Device realm, key at enrolment.** The one-time enrolment code is the trust anchor, so the key rides on it; no separate key endpoint, no staff token for sync. Each op names its staff member.
- **Money ops are never refused for a lapsed permission (S3).** The sale happened; it is applied and an `sync.permission_lapsed` audit event is written. A large discount approved on the hub is applied with a `sync.discount_approved_offline` audit event - a manager PIN never travels in the outbox.
- **A replayed cash settle skips the open-shift check** that online cash needs (#208): the hub already took the cash.
- **Tickets by order + station (#297).** The cloud makes its own ticket ids in `fireOnSend`, so the hub names the order and station. `fireOnSend` keeps at most one queued ticket per order and station, so a bump means that one and a recall the one bumped last; none in that state means a re-send already applied (no-op), no ticket at all is rejected `not_found`.
- **Re-sends are safe.** Ledger first; if the ledger write was lost after an apply, the re-sent create hits the hub's own id (unique violation → accepted), a status already reached is a no-op, an already finalized bill is accepted; likewise an already voided line, a discarded order (its `order.discarded` audit exists), a closed shift, a bumped/recalled ticket.
- **Settle window.** Pull only shows changes older than 30 s, so a slower transaction that took a lower id is not skipped; a transaction longer than that could still be missed (upgrade path: commit-ordered feed).
- **No FK from `sync_changes` to `tenants`** - an append-only log read by tenant; an FK would make every tenant hard-delete clear it first.
- Pull and bootstrap filter by tenant explicitly on top of RLS, as the rest of the codebase does.
- **`cursor_expired` without a watermark (#292).** A hub's cursor is always one of its own tenant's change ids (or 0), so "below the oldest kept id" means changes it never saw were pruned. Keeping each tenant's newest change stops a quiet tenant's caught-up hub from reading as expired.

## Hub mode (issue #293)

The hub till runs this backend's own POS and kitchen code on an in-process PGlite store (Postgres in WebAssembly) - HUB-BUILD-PLAN H1/H7.

- **Entry** `src/hub/hub-main.ts`. Env: `HUB_DATA_DIR` (PGlite data dir, required), `HUB_PORT` (default 8180), `POS_JWT_SECRET` (required; the hub's own, so a hub token is never valid in the cloud). Listens on `127.0.0.1` only, no CORS. `STRIPE_SECRET_KEY` is cleared, so any Stripe path answers 503 `payments_not_configured`.
- **Store** `src/hub/store.ts`: opens PGlite, applies each `prisma/migrations/*/migration.sql` not yet in `hub_migrations` (one transaction each, so a restart applies only new ones), grants the `restiq_app` role every table and sequence, then `SET ROLE restiq_app` on the one connection Prisma uses (`pglite-prisma-adapter`) - PGlite's own user is a superuser and would bypass RLS. `setPrismaClient()` in `src/db/client.ts` installs that client before Nest boots.
- **Module** `src/hub/hub.module.ts`: `PlatformModule` + `KitchenModule` + the POS controllers and services listed directly - not `PosModule`, so `OpsModule`, `GuestModule`, sync, admin and webhook controllers and the sync-health sweep timer are never created. `GuestSessionsService`, `GuestBillsService`, `GuestCardPaymentsService` and `CardReadersService` are provided only because POS services inject them.
- **Allowlist** `src/hub/allowlist.ts`: method + path list of what the POS and KDS screens call (plan §1) plus `GET /health`; anything else answers 404 `{ error: { code: 'not_on_hub' } }`.
- **Artifact** `pnpm build:hub` → `dist-hub/{hub.cjs, migrations/, package.json, node_modules/}`: `nest build` (decorator metadata) then esbuild bundles `dist/hub/hub-main.js`; `argon2` and `@electric-sql/pglite` stay external and are `npm install`ed next to it. Run with `node dist-hub/hub.cjs`. About 41 MB on disk (hub.cjs 14 MB, PGlite 25 MB, argon2 1 MB), 12 MB gzipped.
- **Checks**: `src/hub/hub.spec.ts` (in-memory PGlite, in `pnpm test`): every migration applies once, PIN login + `GET /pos/v1/menu`, 404 off the allowlist, RLS under the app role. `pnpm smoke:hub` boots the built artifact on a temp dir; CI job `hub-smoke` runs it on ubuntu and windows-latest and uploads `restiq-hub` from main.
- Not yet: bootstrap import (H2), op recorder and journal (H3), sync worker (H4), recovery (H5), lock (H6).
