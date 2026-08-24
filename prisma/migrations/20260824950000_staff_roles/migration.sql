-- CreateTable
CREATE TABLE "staff_users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "pin_hash" TEXT,
    "pin_issued_at" TIMESTAMPTZ(6),
    "pin_revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_users_tenant_id_idx" ON "staff_users"("tenant_id");

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "staff_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "staff_users"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "staff_users" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

