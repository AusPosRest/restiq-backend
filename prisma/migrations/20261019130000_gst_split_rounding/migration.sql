-- restiq-backend#244: per-tenant India CGST/SGST odd-paisa rounding rule.
-- tenant_tax_registrations already has its RLS policies; no new ones needed.
CREATE TYPE "GstSplitRounding" AS ENUM ('exact_total', 'equal_half_up', 'equal_half_even');

ALTER TABLE "tenant_tax_registrations" ADD COLUMN "gst_split_rounding" "GstSplitRounding" NOT NULL DEFAULT 'exact_total';
