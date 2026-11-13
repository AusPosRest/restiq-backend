-- restiq-backend#221: how a refund's money went back. Nullable - notes issued before this have no recorded method.
ALTER TABLE "credit_notes" ADD COLUMN "method" "TenderMethod";
