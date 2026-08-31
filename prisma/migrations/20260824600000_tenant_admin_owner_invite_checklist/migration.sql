-- AlterTable: owner invites gain a used marker, distinct from expiry, so
-- accept-invite (CAP-1) can tell "already used" apart from "expired".
ALTER TABLE "owner_invites" ADD COLUMN "used_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "owner_users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "owner_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_progress" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_details_at" TIMESTAMPTZ(6),
    "floor_plan_at" TIMESTAMPTZ(6),
    "menu_import_at" TIMESTAMPTZ(6),
    "devices_at" TIMESTAMPTZ(6),
    "staff_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "checklist_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "owner_users_tenant_id_email_key" ON "owner_users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_progress_tenant_id_key" ON "checklist_progress"("tenant_id");

-- AddForeignKey
ALTER TABLE "owner_users" ADD CONSTRAINT "owner_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_progress" ADD CONSTRAINT "checklist_progress_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "owner_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "owner_users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "owner_users"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "owner_users" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "checklist_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "checklist_progress" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "checklist_progress"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "checklist_progress" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

-- Owner-invite acceptance (AD-10/CAP-1): the accept-invite flow authenticates
-- by possession of the raw token, before any tenant_id is known, so it needs
-- a narrow cross-tenant SELECT distinct from the ops console's operator_read.
-- The transaction sets this context only for the lookup, then switches to the
-- found tenant's app.tenant_id for the rest of the write (same pattern as
-- enrolment-code consumption).
CREATE POLICY "invite_accept_read" ON "owner_invites" FOR SELECT
  USING (current_setting('app.invite_accept_context', true) = 'invite');
