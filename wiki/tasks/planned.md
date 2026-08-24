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
