-- restiq-backend#171: failed sign-in counters shared by every API instance and
-- surviving restarts (they used to live in process memory). One row per
-- throttle key (e.g. POS PIN attempts from one device or IP of a tenant,
-- owner/operator logins per email and per IP, manager-PIN tries per staff
-- member, guest joins per table). A fixed window: `attempts` counts tries
-- since `window_started_at`; rows are purged a day after their window.
-- Additive: a new table only. Not tenant-scoped (keys are opaque strings), so
-- no RLS - the same as tenant_registry.
CREATE TABLE "auth_attempts" (
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "auth_attempts_window_started_at_idx" ON "auth_attempts"("window_started_at");
