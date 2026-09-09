-- Simulated card terminal (issue #130, first slice of epic #129): a sixth
-- device type, the payment_intents table it drains, the four electronic
-- tender methods, and the tender<->intent link that makes an electronic
-- tender provable. RLS mirrors print_jobs. Every enum value added below is
-- only USED by a later migration/transaction (Postgres forbids using a new
-- enum value inside the transaction that added it); the CHECK constraint
-- references pre-existing values only.
ALTER TYPE "DeviceType" ADD VALUE 'terminal';
ALTER TYPE "TenderMethod" ADD VALUE 'upi_intent';
ALTER TYPE "TenderMethod" ADD VALUE 'upi_qr';
ALTER TYPE "TenderMethod" ADD VALUE 'card_online';
ALTER TYPE "TenderMethod" ADD VALUE 'card_terminal';

-- CreateEnum
CREATE TYPE "PaymentRail" AS ENUM ('upi_intent', 'upi_qr', 'card_online', 'card_terminal');
CREATE TYPE "PaymentIntentStatus" AS ENUM ('created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled');
CREATE TYPE "PaymentProviderKind" AS ENUM ('simulated', 'razorpay');

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "share_id" UUID,
    "rail" "PaymentRail" NOT NULL,
    "provider" "PaymentProviderKind" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'created',
    "client_key" TEXT NOT NULL,
    "provider_ref" TEXT,
    "client_payload" JSONB NOT NULL,
    "failure_reason" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "succeeded_at" TIMESTAMPTZ(6),
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_tenant_id_client_key_key" ON "payment_intents"("tenant_id", "client_key");
CREATE INDEX "payment_intents_tenant_id_idx" ON "payment_intents"("tenant_id");
CREATE INDEX "payment_intents_bill_id_status_idx" ON "payment_intents"("bill_id", "status");
CREATE INDEX "payment_intents_outlet_id_status_idx" ON "payment_intents"("outlet_id", "status");

-- One ACTIVE intent per target: the whole bill (share_id NULL, folded to the
-- nil uuid so NULLs compare equal) or one guest share on it. A second
-- concurrent create races into a unique violation, never a second charge.
CREATE UNIQUE INDEX "payment_intents_one_active"
  ON "payment_intents" ("bill_id", COALESCE("share_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" IN ('created', 'pending');

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_created_by_staff_id_fkey" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: the tender<->intent link and the FR-52 risk acknowledgement.
ALTER TABLE "tenders" ADD COLUMN "payment_intent_id" UUID;
ALTER TABLE "tenders" ADD COLUMN "risk_acknowledged" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "tenders_payment_intent_id_key" ON "tenders"("payment_intent_id");
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An electronic tender cannot exist without its intent, and a cash / manual
-- tender can never claim one (ADR-001). Only pre-existing enum values are
-- named here, so this is safe inside the same transaction as the ADD VALUEs.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_electronic_needs_intent"
  CHECK (("method" IN ('cash', 'upi_manual')) = ("payment_intent_id" IS NULL));

ALTER TABLE "payment_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_intents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payment_intents"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "payment_intents" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
