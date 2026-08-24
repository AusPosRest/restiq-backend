-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "branding_tokens" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "tenant_capabilities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_capabilities_tenant_id_key_key" ON "tenant_capabilities"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "outlets_tenant_id_idx" ON "outlets"("tenant_id");

-- CreateIndex
CREATE INDEX "tenants_created_at_idx" ON "tenants"("created_at");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenants_country_idx" ON "tenants"("country");

-- AddForeignKey
ALTER TABLE "tenant_capabilities" ADD CONSTRAINT "tenant_capabilities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security (AD-5), same posture as every tenant-owned table:
-- tenant_isolation for reads/writes under app.tenant_id, operator_read for
-- the console's explicit cross-tenant read context.
ALTER TABLE "tenant_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_capabilities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_capabilities"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "tenant_capabilities" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
