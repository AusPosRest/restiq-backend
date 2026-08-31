-- CreateTable
CREATE TABLE "outlet_capabilities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outlet_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outlet_capabilities_tenant_id_idx" ON "outlet_capabilities"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_capabilities_outlet_id_key_key" ON "outlet_capabilities"("outlet_id", "key");

-- AddForeignKey
ALTER TABLE "outlet_capabilities" ADD CONSTRAINT "outlet_capabilities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_capabilities" ADD CONSTRAINT "outlet_capabilities_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "outlet_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outlet_capabilities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "outlet_capabilities"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "outlet_capabilities" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

