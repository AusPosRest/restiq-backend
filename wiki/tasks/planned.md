# Planned

- Tenant Admin: the outlet-details editing story still needs to wire
  `PATCH /admin/v1/checklist/:step { step: "outlet_details" }` from its own
  write path.
- Tenant Admin stories 6, 7: wire each feature's write path to call
  `PATCH /admin/v1/checklist/:step` for its checklist step (devices, staff
  respectively) instead of leaving it manual. See the integration-points
  section in [wiki/features/tenant-admin.md](../features/tenant-admin.md).
  (floor_plan and menu_import are done - stories 5 and 2.)
