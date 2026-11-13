-- restiq-backend#241 (Q28): store the cash round-off on the bill and the cash handed over on a cash tender, so shift close and cash reports count what went into the drawer.
ALTER TABLE "bills" ADD COLUMN "round_off_minor" BIGINT;
ALTER TABLE "tenders" ADD COLUMN "tendered_minor" BIGINT;
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_tendered_cash_only"
  CHECK ("tendered_minor" IS NULL OR ("method" = 'cash' AND "tendered_minor" >= "amount_minor"));
