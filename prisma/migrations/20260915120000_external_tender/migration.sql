-- issue #146: a payment taken outside RESTIQ (standalone EFTPOS, delivery app,
-- bank transfer). Cashier-asserted like cash - no payment intent - and it
-- always carries the outside system's reference / bill number.
ALTER TYPE "TenderMethod" ADD VALUE 'external';

ALTER TABLE "tenders" ADD COLUMN "reference" TEXT;

-- The new enum value can't be cast inside the transaction that adds it, so
-- both checks compare method as text.
ALTER TABLE "tenders" DROP CONSTRAINT "tenders_electronic_needs_intent";
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_electronic_needs_intent"
  CHECK (("method"::text IN ('cash', 'upi_manual', 'external')) = ("payment_intent_id" IS NULL));
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_external_needs_reference"
  CHECK (("method"::text = 'external') = ("reference" IS NOT NULL));
