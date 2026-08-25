-- pos/CAP-7 bill & settle (AD-14). bills.bill_number is nullable and only
-- ever set once, by src/pos/bills/bills.service.ts's finalize(), reserved
-- from bill_number_counters (one row per outlet, incremented by a plain
-- transactional UPDATE - not a Postgres SEQUENCE, whose nextval() would not
-- roll back with an aborted finalise and would leave a real gap). The
-- (tenant_id, outlet_id, bill_number) unique index below is a plain index,
-- not partial: Postgres already treats every NULL as distinct in a unique
-- index, so any number of still-open bills coexist without a WHERE clause.
-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('open', 'finalized');

-- CreateEnum
CREATE TYPE "TenderMethod" AS ENUM ('cash', 'upi_manual');

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "bill_number" INTEGER,
    "subtotal_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT,
    "discount_reason" TEXT,
    "status" "BillStatus" NOT NULL DEFAULT 'open',
    "created_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_by_staff_id" UUID,
    "finalized_at" TIMESTAMPTZ(6),

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "method" "TenderMethod" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_number_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bill_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bills_order_id_key" ON "bills"("order_id");

-- CreateIndex
CREATE INDEX "bills_tenant_id_idx" ON "bills"("tenant_id");

-- CreateIndex
CREATE INDEX "bills_outlet_id_idx" ON "bills"("outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "bills_tenant_id_outlet_id_bill_number_key" ON "bills"("tenant_id", "outlet_id", "bill_number");

-- CreateIndex
CREATE INDEX "tenders_tenant_id_idx" ON "tenders"("tenant_id");

-- CreateIndex
CREATE INDEX "tenders_bill_id_idx" ON "tenders"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_number_counters_outlet_id_key" ON "bill_number_counters"("outlet_id");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_created_by_staff_id_fkey" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_finalized_by_staff_id_fkey" FOREIGN KEY ("finalized_by_staff_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_number_counters" ADD CONSTRAINT "bill_number_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_number_counters" ADD CONSTRAINT "bill_number_counters_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "bills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bills" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bills"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "bills" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "tenders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenders"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "tenders" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "bill_number_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bill_number_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bill_number_counters"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "bill_number_counters" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
