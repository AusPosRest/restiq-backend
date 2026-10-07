# Offline sync for the Windows hub till - backend

Design: Restiq `docs/SYNC-DESIGN.md` (accepted 2026-10-07). Issue restiq-backend#185.

## Capabilities

- **D15** Offline-first selling - one hub till per outlet sells offline and catches the cloud up; the cloud owns menu, prices, staff and floor plan, the hub owns sales.

## What's built

- **Device key at enrolment** - `POST /device/v1/enroll` takes optional `publicKey` (base64 SPKI DER, ed25519), checked before the code is used up - `src/ops/devices/devices.service.ts`.
- **Device realm** - `/sync/v1/*` is signed, not token-authenticated: headers `X-Device-Id`, `X-Device-Timestamp` (ms), `X-Device-Signature` (base64 ed25519 over `METHOD\npath?query\ntimestamp\nsha256hex(raw body)`), 5-minute skew. 401 `invalid_signature` for any failure, 403 `device_revoked` / `device_not_in_outlet` / `tenant_inactive` - `src/platform/device-sync.guard.ts`, `device-signature.ts`. `main.ts` keeps the raw body for this.
- **Change feed** - `sync_changes` (bigserial id = cursor), written by the `sync_record_change()` trigger on the 19 cloud-owned tables - migration `20261008100000_offline_sync`.
- `GET /sync/v1/bootstrap` - every cloud-owned row for the device's tenant and outlet as plain rows (database column names), the role permission catalogue, `policy` (`maxOfflineHours` from `tenants.max_offline_hours`, default 24; `syncIntervalSeconds` 30) and a cursor - `src/pos/sync/sync.service.ts`.
- `GET /sync/v1/pull?cursor=&limit=` - rows changed after the cursor, latest per row, read as they are now (`delete` when gone).
- `POST /sync/v1/push` - see below - `src/pos/sync/sync-push.service.ts`.
- `GET /sync/v1/session-status`, `GET /sync/v1/rejections`, `POST /sync/v1/rejections/:opId/acknowledge`.

### Push

Body `{batchId, ops[1..200]}` (201+ → 413 `batch_too_large`). Each op `{opId, seq, type, at, actorStaffId, payload}`. Result per op: `accepted`, `duplicate` (opId already in the AD-7 `applied_ops` ledger), `rejected` (with `code`, kept in `sync_dead_letters`), or `deferred` (`seq_gap`: seq is not `lastAppliedSeq + 1`, so this op and the rest wait for the missing one).

| type | payload | online equivalent |
|---|---|---|
| `order.create` | `orderId`, and `tableId` or `tokenNumber` (counter order keeps the hub's token) | open table / counter order |
| `order.line.add` | `orderId`, `lineId`, `itemId`, `variantId?`, `quantity`, `modifierIds?`, `seatNumber?`, `unitPriceMinor` (string), `modifierPriceMinor?` (`{modifierId: string}`) | add line - at the hub's price, not today's |
| `order.line.update` | `orderId`, `lineId`, plus the update fields | update line |
| `order.line.remove` | `orderId`, `lineId` | remove line |
| `order.status` | `orderId`, `status` | status change (fires kitchen tickets on `sent`) |
| `bill.create` | `orderId`, `billId` | create bill |
| `bill.finalize` | `billId`, `tenders`, `tenderIds` (one per tender), `discountMinor?`, `discountReason?` | finalize |

Ids made on the hub are kept, and `at` becomes the row's `createdAt` / `finalizedAt`.

## Integration points for later stories

- Desktop hub (restiq-desktop): bootstrap into its local store, outbox → push, pull every `syncIntervalSeconds`, lock when `mustSyncBefore` passes.
- Per-device bill number series waits on decision O5; bills are still numbered by the cloud at finalize.
- `ticket.bump`: kitchen tickets get cloud ids at send, so a hub bump cannot name them yet - needs ticket ids from the hub or a bump by order + station.
- Ops dead-letter replay of sync ops (payload is not stored, by NFR-15).

## Key decisions

- **Device realm, key at enrolment.** The one-time enrolment code is the trust anchor, so the key rides on it; no separate key endpoint, no staff token for sync. Each op names its staff member.
- **Money ops are never refused for a lapsed permission (S3).** The sale happened; it is applied and an `sync.permission_lapsed` audit event is written. A large discount approved on the hub is applied with a `sync.discount_approved_offline` audit event - a manager PIN never travels in the outbox.
- **Re-sends are safe.** Ledger first; if the ledger write was lost after an apply, the re-sent create hits the hub's own id (unique violation → accepted), a status already reached is a no-op, an already finalized bill is accepted.
- **Settle window.** Pull only shows changes older than 30 s, so a slower transaction that took a lower id is not skipped; a transaction longer than that could still be missed (upgrade path: commit-ordered feed).
- **No FK from `sync_changes` to `tenants`** - an append-only log read by tenant; an FK would make every tenant hard-delete clear it first.
- Pull and bootstrap filter by tenant explicitly on top of RLS, as the rest of the codebase does.
