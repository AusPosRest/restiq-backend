-- #284 Stripe card payments on the guest's phone (direct charges on the restaurant's connected account).
ALTER TYPE "PaymentProviderKind" ADD VALUE 'stripe';

-- Last known "card payments active" from Stripe, refreshed by the ops Payments tab, so a guest
-- bill read never calls Stripe.
ALTER TABLE "tenant_payment_accounts" ADD COLUMN "card_payments_active" BOOLEAN NOT NULL DEFAULT false;
