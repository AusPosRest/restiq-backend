# restiq-backend wiki

Living documentation for this repo. Update the relevant feature doc and move
the task entry to `tasks/completed.md` after every feature or bug fix.

## Features

- [Tenant Admin (Owner Web Console) - backend](features/tenant-admin.md) -
  CAP-1 owner invite & account setup, CAP-2 go-live checklist, CAP-3
  AI-assisted menu import, CAP-4 menu management, CAP-5 floor plan &
  stations, CAP-6 devices & printers, CAP-10 branding & capabilities.
- [Platform Console (Internal Operator Console) - backend](features/platform-console.md) -
  currently just the AD-12 device-fleet cross-reference for Tenant Admin's
  CAP-6.
- [POS Cashier & Waiter (Web Prototype) - backend](features/pos-cashier-waiter.md) -
  CAP-1 PIN login, outlet picker, lockout, and shift clock in/out; CAP-2
  table map and order ownership/transfer; CAP-3 order taking with
  modifiers/variants (`OrderLine`/`OrderLineModifier`, price snapshotted at
  add-time); CAP-8 manager authorisation gate (`platform/manager-auth`,
  shared infrastructure for the void/discount/refund/no-sale stories still
  to come); CAP-10 shift open, cash management, and blind-count close.
- [Customer QR Self-Order (Guest Mobile Web) - backend](features/qr-self-order.md) -
  CAP-1 guest realm (fifth disjoint auth realm, AD-17), greenfield
  `TableSession`/`Guest` models, session start/join/close, and the
  `qr_ordering` capability gate.
- [Kitchen Display (KDS) - backend](features/kitchen-display.md) - CAP-1
  ticket domain, item->station routing, and fire-on-send: the `open ->
  sent` transition now creates real `Ticket`/`TicketLine` rows (greenfield,
  insert-only past bump), grouped per resolved station, with bump/recall/
  refire actions and the station-queue/expo/bumped/all-day read
  projections every KDS screen story consumes.

## Tasks

- [Completed](tasks/completed.md)
- [In progress](tasks/in-progress.md)
- [Planned](tasks/planned.md)
