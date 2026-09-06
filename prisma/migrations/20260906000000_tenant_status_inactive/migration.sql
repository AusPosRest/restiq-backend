-- Tenant lifecycle (issue #117): a deactivated tenant is 'inactive', distinct
-- from 'provisioning' (never activated) and 'active'. Soft delete continues
-- to use the existing tenants.deleted_at column - no new status for it.
ALTER TYPE "TenantStatus" ADD VALUE 'inactive';
