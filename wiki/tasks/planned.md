# Planned

- Tenant Admin: the outlet-details editing story still needs to wire
  `PATCH /admin/v1/checklist/:step { step: "outlet_details" }` from its own
  write path. (floor_plan, menu_import, devices, and staff are all done -
  stories 5, 2, 6, and 7.)
- Tenant Admin CAP-7: outlet-scoped staff access (which outlets a staff
  member can work at) is not modelled - `roles` and `staff_users` are both
  tenant-wide today, despite the SPEC's CAP-7 intent line mentioning
  "outlet-scoped roles" and the T7 design render showing per-outlet access
  checkboxes. See the CAP-7 key-decisions note in
  [wiki/features/tenant-admin.md](../features/tenant-admin.md).
- POS Cashier & Waiter: CAP-1 (PIN login/clock), CAP-2 (table map &
  ownership), CAP-3 (order taking with modifiers/variants), CAP-4 (group
  ordering - seats/covers on `OrderLine`), CAP-5 (open/held orders), CAP-7
  (bill & settle), CAP-8 (manager authorisation service), CAP-10 (shift &
  cash management), and CAP-11 (device & staff attendance status) are done.
  Still planned: CAP-6 QSR counter & token (composes directly over CAP-7's
  `pos/bills` endpoints per the architecture's capability map - no new
  bill/settle code path expected) and CAP-9 refunds (reads a finalised
  `Bill`'s real totals, issues a separate `CreditNote`, never mutates the
  `Bill`). CAP-3's still-unimplemented void/comp paths and CAP-9's refund
  path still need to call into CAP-8's `ManagerAuthService` - each gated
  action calls `ManagerAuthService.authorize()`/`.recordApproval()` per
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md)'s
  "How to call this" section instead of reimplementing their own PIN check,
  the same way CAP-7's discount-above-threshold path now does. CAP-7's
  `POST /pos/v1/bills/:id/finalize` deliberately does not validate a
  tender's amount against CAP-4's `OrderLine.seatNumber` for a per-seat
  split - see that story's "Key decisions" entry - so a future per-seat
  billing UI would compute those amounts client-side, not get them checked
  server-side.
