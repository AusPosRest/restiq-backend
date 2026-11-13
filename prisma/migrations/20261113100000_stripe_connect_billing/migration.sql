-- #282 Stripe Connect (restaurant payment accounts) and card billing for subscriptions.
-- CreateEnum
CREATE TYPE "CardBillingStatus" AS ENUM ('pending', 'active', 'past_due', 'canceled');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "card_billing_status" "CardBillingStatus",
ADD COLUMN     "stripe_customer_id" TEXT,
ADD COLUMN     "stripe_subscription_id" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "stripe_invoice_id" TEXT;

-- CreateTable
CREATE TABLE "tenant_payment_accounts" (
    "tenant_id" UUID NOT NULL,
    "stripe_account_id" TEXT,
    "allowed_methods" TEXT[] DEFAULT ARRAY['card', 'apple_pay', 'google_pay']::TEXT[],
    "fee_percent_bps" INTEGER NOT NULL DEFAULT 0,
    "fee_fixed_minor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_payment_accounts_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_payment_accounts_stripe_account_id_key" ON "tenant_payment_accounts"("stripe_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices"("stripe_invoice_id");

-- AddForeignKey
ALTER TABLE "tenant_payment_accounts" ADD CONSTRAINT "tenant_payment_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tenant data: same RLS posture as subscriptions/invoices (tenant writes, operator reads).
ALTER TABLE "tenant_payment_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_payment_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_payment_accounts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "tenant_payment_accounts" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
