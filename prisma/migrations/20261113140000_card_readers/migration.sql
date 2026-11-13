-- #286 Card readers (Stripe Terminal smart readers on the restaurant's connected account) and reader orders.
-- CreateEnum
CREATE TYPE "ReaderModel" AS ENUM ('s700', 'wisepos_e');

-- CreateEnum
CREATE TYPE "ReaderOrderStatus" AS ENUM ('payment_failed', 'paid', 'ordered', 'shipped', 'delivered', 'cancelled');

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN "stripe_terminal_location_id" TEXT;

-- CreateTable
CREATE TABLE "card_readers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "stripe_reader_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_readers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: platform-level like plan_prices (no tenant, no RLS). NULL price = not for sale.
CREATE TABLE "reader_prices" (
    "country" "Country" NOT NULL,
    "model" "ReaderModel" NOT NULL,
    "display_name" TEXT NOT NULL,
    "price_minor" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_prices_pkey" PRIMARY KEY ("country", "model"),
    CONSTRAINT "reader_prices_price_check" CHECK ("price_minor" IS NULL OR "price_minor" >= 0)
);

-- CreateTable
CREATE TABLE "reader_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "model" "ReaderModel" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "shipping" JSONB NOT NULL,
    "status" "ReaderOrderStatus" NOT NULL,
    "failure_message" TEXT,
    "stripe_invoice_id" TEXT,
    "tracking_ref" TEXT,
    "ops_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reader_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reader_orders_quantity_check" CHECK ("quantity" BETWEEN 1 AND 5),
    CONSTRAINT "reader_orders_total_check" CHECK ("unit_price_minor" >= 0 AND "total_minor" = "unit_price_minor" * "quantity")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_readers_stripe_reader_id_key" ON "card_readers"("stripe_reader_id");

-- CreateIndex
CREATE INDEX "card_readers_tenant_id_idx" ON "card_readers"("tenant_id");

-- CreateIndex
CREATE INDEX "card_readers_outlet_id_idx" ON "card_readers"("outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "reader_orders_stripe_invoice_id_key" ON "reader_orders"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "reader_orders_tenant_id_idx" ON "reader_orders"("tenant_id");

-- CreateIndex
CREATE INDEX "reader_orders_status_created_at_idx" ON "reader_orders"("status", "created_at");

-- AddForeignKey
ALTER TABLE "card_readers" ADD CONSTRAINT "card_readers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_readers" ADD CONSTRAINT "card_readers_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_orders" ADD CONSTRAINT "reader_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_orders" ADD CONSTRAINT "reader_orders_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant data: same RLS posture as tenant_payment_accounts (tenant writes, operator reads).
ALTER TABLE "card_readers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_readers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "card_readers"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "card_readers" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "reader_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reader_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reader_orders"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "reader_orders" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

-- Both models on both countries, not for sale until an operator sets a price.
INSERT INTO "reader_prices" ("country", "model", "display_name") VALUES
  ('AU', 's700', 'Stripe Reader S700'), ('AU', 'wisepos_e', 'BBPOS WisePOS E'),
  ('IN', 's700', 'Stripe Reader S700'), ('IN', 'wisepos_e', 'BBPOS WisePOS E');
