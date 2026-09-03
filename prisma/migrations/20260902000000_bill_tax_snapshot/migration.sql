-- issue #103: country-aware tax engine snapshot. Nullable/defaulted so
-- existing bill rows need no backfill - only bills created from here on ever
-- set tax_breakdown; prices_include_tax defaults to false (every pre-existing
-- bill was computed tax-exclusive, same as the old flat placeholder).
ALTER TABLE "bills" ADD COLUMN     "tax_breakdown" JSONB,
ADD COLUMN     "prices_include_tax" BOOLEAN NOT NULL DEFAULT false;
