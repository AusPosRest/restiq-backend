-- pos/CAP-6 QSR counter and token mode (AD-14, story 7). orders.token_number
-- is nullable and only ever set once, at creation time for a counter order
-- (table_id null), by src/pos/orders/orders.service.ts's
-- createCounterOrder() - reserved from token_number_counters (one row per
-- outlet, incremented by a plain transactional UPDATE, not a Postgres
-- SEQUENCE, whose nextval() would not roll back with an aborted creation
-- attempt and would leave a real gap). The
-- (tenant_id, outlet_id, token_number) unique index below is a plain index,
-- not partial: Postgres already treats every NULL as distinct in a unique
-- index, so any number of table (dine-in) orders - which never carry a
-- token number - coexist without a WHERE clause. Same posture as
-- bills.bill_number / bill_number_counters (20260825400000_bill_and_settle).
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "token_number" INTEGER;

-- CreateTable
CREATE TABLE "token_number_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "token_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "token_number_counters_outlet_id_key" ON "token_number_counters"("outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_outlet_id_token_number_key" ON "orders"("tenant_id", "outlet_id", "token_number");

-- AddForeignKey
ALTER TABLE "token_number_counters" ADD CONSTRAINT "token_number_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_number_counters" ADD CONSTRAINT "token_number_counters_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "token_number_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "token_number_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "token_number_counters"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "token_number_counters" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
