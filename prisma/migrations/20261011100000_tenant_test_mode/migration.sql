-- Per-tenant Test / Live mode (restiq-backend#213). live_since is when the tenant last went Live;
-- NULL means the tenant is in Test mode (simulated payments, simulated mail, kept out of platform KPIs).
-- A bill finalised before live_since was a test sale. Every existing tenant is Live from its creation.
ALTER TABLE "tenants" ADD COLUMN "live_since" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP;
UPDATE "tenants" SET "live_since" = "created_at";
