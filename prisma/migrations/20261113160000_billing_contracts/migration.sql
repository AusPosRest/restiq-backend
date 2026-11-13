-- #290 Per-restaurant billing contracts: typed line items replacing the plan price when present.
-- CreateEnum
CREATE TYPE "BillingItemKind" AS ENUM ('recurring', 'one_time');

-- CreateTable
CREATE TABLE "billing_line_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_amount_minor" BIGINT NOT NULL,
    "kind" "BillingItemKind" NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "billed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_line_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_line_items_description_check" CHECK (char_length("description") BETWEEN 1 AND 120),
    CONSTRAINT "billing_line_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 1000),
    CONSTRAINT "billing_line_items_amount_check" CHECK ("unit_amount_minor" BETWEEN 0 AND 100000000),
    CONSTRAINT "billing_line_items_billed_check" CHECK ("billed_at" IS NULL OR "kind" = 'one_time')
);

-- CreateIndex
CREATE INDEX "billing_line_items_tenant_id_idx" ON "billing_line_items"("tenant_id");

-- AddForeignKey
ALTER TABLE "billing_line_items" ADD CONSTRAINT "billing_line_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant data: same RLS posture as card_readers (tenant writes, operator reads).
ALTER TABLE "billing_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_line_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "billing_line_items"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "billing_line_items" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
