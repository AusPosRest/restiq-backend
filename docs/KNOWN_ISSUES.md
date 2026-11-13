# Known issues

## Hub rebuild loses acked open state (found by #310)

When startup recovery (H5, `openOrRebuild`) rebuilds a broken PGlite store, it imports `bootstrap.json` (the first bootstrap's snapshot) and `reconcile` replays only ops above `outbox.ack`. Anything whose op the cloud already acknowledged is missing from the rebuilt hub: the open shift (a cash finalize answers 409 `shift_not_open`; opening a new shift works on the hub but the cloud still has the old one open), and open orders or bills pushed before the crash. Closed sales are fine (they live in the cloud).

Workaround: open a new shift on the till after a rebuild; reopen any lost open order. Likely fix: after a rebuild, once the outbox has drained, bootstrap again with `include=open_sales` (the worker already does this on `cursor_expired` with an empty outbox).

Covered by `test/hub-matrix.e2e-spec.ts` (the revoke case opens a new shift after the rebuild).
