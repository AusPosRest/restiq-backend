-- Simulated receipt printer (issue #127): a fifth device type plus the
-- print-job spool it drains. RLS mirrors bill_shares.
ALTER TYPE "DeviceType" ADD VALUE 'printer';

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printed_at" TIMESTAMPTZ(6),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "print_jobs_tenant_id_idx" ON "print_jobs"("tenant_id");

-- CreateIndex
CREATE INDEX "print_jobs_outlet_id_printed_at_idx" ON "print_jobs"("outlet_id", "printed_at");

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "print_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "print_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "print_jobs"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "print_jobs" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
