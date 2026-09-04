-- Add opt-in tax-registration flag for AU receipts.
ALTER TABLE "tenant_tax_registrations" ADD COLUMN "gst_registered" BOOLEAN NOT NULL DEFAULT true;
