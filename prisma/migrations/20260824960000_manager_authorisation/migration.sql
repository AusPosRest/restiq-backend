-- CAP-8 manager authorisation gate (AD-15).
--
-- roles.is_manager: the flag platform/manager-auth checks to find a
-- StaffUser who can approve a gated action. Backfilled true for the two
-- existing seeded roles a real restaurant would trust with that authority
-- ('Owner', 'Manager') - the other four (Cashier, Waiter, Kitchen,
-- Accountant) stay false. Future tenants get this from
-- tenants.service.ts's SYSTEM_ROLES directly; this backfill only covers
-- tenants provisioned before this migration.
ALTER TABLE "roles" ADD COLUMN "is_manager" BOOLEAN NOT NULL DEFAULT false;

UPDATE "roles" SET "is_manager" = true WHERE "name" IN ('Owner', 'Manager') AND "is_system" = true;

-- audit_events.approver_id / approver_name: populated only for manager-gated
-- audit rows (null for every other AD-6 audit action, e.g.
-- staff.role_changed). Nullable, additive - no RLS policy change needed,
-- the existing tenant_id-scoped policies already cover these columns.
ALTER TABLE "audit_events" ADD COLUMN "approver_id" UUID;
ALTER TABLE "audit_events" ADD COLUMN "approver_name" TEXT;
