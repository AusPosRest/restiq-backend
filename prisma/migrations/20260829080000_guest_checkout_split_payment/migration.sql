-- qr-self-order/CAP-5 (issue #80, AD-18): guest checkout reuses the real
-- Bill/Tender money path - no parallel guest settlement model. Two changes:
--  1. bills.created_by_staff_id becomes nullable, same posture as
--     orders.owner_id going nullable in 20260829070000_guest_order_placement
--     for the exact same reason (a guest-checkout Bill has no staff
--     creator - see Bill.createdByStaffId's schema comment).
--  2. a new bill_shares table: the per-guest settlement breakdown over a
--     guest-checkout Bill (see BillShare's schema comment for why a failed
--     simulated payment needs no "failed" status - UJ-5's invariant is that
--     a failure writes nothing at all).

-- AlterTable "bills": created_by_staff_id becomes nullable.
ALTER TABLE "bills" ALTER COLUMN "created_by_staff_id" DROP NOT NULL;

-- CreateEnum
CREATE TYPE "BillShareStatus" AS ENUM ('outstanding', 'paid');

-- CreateTable
CREATE TABLE "bill_shares" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "guest_name" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "BillShareStatus" NOT NULL DEFAULT 'outstanding',
    "payer_phone" TEXT,
    "tender_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bill_shares_bill_id_guest_id_key" ON "bill_shares"("bill_id", "guest_id");

-- CreateIndex
CREATE INDEX "bill_shares_tenant_id_idx" ON "bill_shares"("tenant_id");

-- CreateIndex
CREATE INDEX "bill_shares_bill_id_idx" ON "bill_shares"("bill_id");

-- CreateIndex
CREATE INDEX "bill_shares_guest_id_idx" ON "bill_shares"("guest_id");

-- AddForeignKey
ALTER TABLE "bill_shares" ADD CONSTRAINT "bill_shares_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_shares" ADD CONSTRAINT "bill_shares_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_shares" ADD CONSTRAINT "bill_shares_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_shares" ADD CONSTRAINT "bill_shares_tender_id_fkey" FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "bill_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bill_shares" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bill_shares"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "bill_shares" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
