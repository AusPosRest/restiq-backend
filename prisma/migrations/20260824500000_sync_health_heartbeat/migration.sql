-- CAP-6 sync health: latest-heartbeat snapshot columns on the existing
-- devices table (a monitoring snapshot, not an event log - NFR-15 is trivial
-- to satisfy here since there is no payload column to begin with). No new
-- RLS policy is needed - these columns inherit the devices table's existing
-- tenant_isolation / operator_read policies from the device-fleet migration.
ALTER TABLE "devices" ADD COLUMN     "app_version" TEXT,
ADD COLUMN     "clock_skew_seconds" INTEGER,
ADD COLUMN     "last_contact_at" TIMESTAMPTZ(6),
ADD COLUMN     "outbox_depth" INTEGER,
ADD COLUMN     "recent_rejection_count" INTEGER;
