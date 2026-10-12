# POS refund authorization (#240)

`POST /pos/v1/bills/:id/refund` retains its request and response fields and returns 201 with a credit note. The POS guard accepts authenticated staff and retains tenant, device, session and outlet checks. Refund authorization runs in the service so the PIN approver can supply the `refunds` permission.

The approving PIN must belong to an active staff member in the bill's tenant whose role has `refunds` and who may work at the bill's outlet. Empty `outletIds` means all outlets. `isManager` alone does not authorize a refund.

- Cashier without `managerPin`: 403 `forbidden`.
- PIN belonging to staff without `refunds` or outside the outlet: 403 `forbidden`.
- Incorrect, revoked or another tenant's PIN: existing 401 `invalid_credentials`.
- Manager without PIN: existing 400 `validation_failed`; manager with valid approval: 201.

Other body validation and bill/line validation remain in force. `approvedByStaffId` and the audit event's `approverId` record the PIN approver; `createdByStaffId` and audit `actorId` record the cashier. No schema or response changes.
