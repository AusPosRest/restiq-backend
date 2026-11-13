# Known issues

## Hub: after a store rebuild, acked open sales are missing until the outbox drains (#310)

When startup recovery (H5, `openOrRebuild`) rebuilds a broken PGlite store it imports `bootstrap.json` and replays only the unacknowledged journal ops, then sets `hub_meta.open_sales_resync`. Once the hub is online and its outbox has fully drained, the sync worker re-imports `bootstrap?include=open_sales` and clears the flag (`GET /pos/v1/hub/status` shows `openSalesResync: true` until then). Covered by matrix case 6 in `test/hub-matrix.e2e-spec.ts`.

What remains, only between the rebuild and that resync (that is, while the rebuilt hub is still offline or still draining):
- The open shift is missing on the hub: a cash finalize answers 409 `shift_not_open`. Opening a new shift then works on the hub, but the cloud still has the old shift open, so that `shift.open` op can be rejected on push.
- Open orders and bills whose ops were already acked are missing: their table looks free on the hub, and a new order opened on it can be rejected by the cloud (one active order per table). Lines cannot be added to the lost order.
- Closed sales are not affected (they live in the cloud).

Workaround: if the cloud is reachable, wait for the till's sync before taking new sales after a crash recovery.

## Hub: a store rebuild restarts the O1 offline clock

`importBootstrap` sets `hub_meta.last_sync_at = now()`, and the rebuild calls it with `bootstrap.json`, so a hub rebuilt while offline gets a fresh `maxOfflineHours` window. Fix: keep the old `last_sync_at` (or `bootstrap.json`'s import time) when importing from the file. Found while writing #310; not fixed.
