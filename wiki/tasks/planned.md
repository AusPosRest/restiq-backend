# Planned

- Tenant Admin stories 2, 5, 6, 7: wire each feature's write path to call
  `PATCH /admin/v1/checklist/:step` for its checklist step (outlet_details,
  floor_plan, devices, staff respectively) instead of leaving it manual. See
  the integration-points section in
  [wiki/features/tenant-admin.md](../features/tenant-admin.md).
- Tenant Admin CAP-3 (AI-assisted menu import): completes the `menu_import`
  checklist step.
