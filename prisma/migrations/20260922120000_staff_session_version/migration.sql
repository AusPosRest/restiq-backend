-- restiq-backend#169: bumped whenever a staff member's access changes (PIN
-- issued/revoked, role changed, logout). A POS/KDS token carries the version
-- it was issued at; the guard rejects it once they differ. Additive: existing
-- rows start at 0.
ALTER TABLE "staff_users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
