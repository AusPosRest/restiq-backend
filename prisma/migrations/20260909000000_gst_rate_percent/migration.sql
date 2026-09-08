-- Configurable GST rate (issue #121): null falls back to the profile default.
ALTER TABLE "tenant_tax_registrations" ADD COLUMN "gst_rate_percent" NUMERIC(5,2);
