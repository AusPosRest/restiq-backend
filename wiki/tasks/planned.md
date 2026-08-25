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
  ownership), CAP-3 (order taking with modifiers/variants), CAP-8 (manager
  authorisation service), and CAP-10 (shift & cash management) are done. Still
  planned: CAP-4 group ordering (seats/covers on `OrderLine`), CAP-5 open/held
  orders (list view over existing `Order` rows), CAP-6 QSR counter & token,
  CAP-7 bill & settle (its discount-above-threshold and price-override paths,
  plus CAP-3's still-unimplemented void/comp, call into CAP-8's
  `ManagerAuthService`), CAP-9 refunds, and CAP-11 device & staff attendance
  status - each gated action calls
  `ManagerAuthService.authorize()`/`.recordApproval()` per
  [wiki/features/pos-cashier-waiter.md](../features/pos-cashier-waiter.md)'s
  "How to call this" section instead of reimplementing their own PIN check.
