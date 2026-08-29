-- CreateEnum
CREATE TYPE "TableSessionStatus" AS ENUM ('open', 'settled', 'closed');

-- CreateTable
CREATE TABLE "table_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'open',
    "session_pin" TEXT NOT NULL,
    "started_by_guest_name" TEXT NOT NULL,
    "started_by_guest_phone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "table_sessions_tenant_id_idx" ON "table_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "table_sessions_outlet_id_idx" ON "table_sessions"("outlet_id");

-- CreateIndex
CREATE INDEX "table_sessions_table_id_idx" ON "table_sessions"("table_id");

-- CreateIndex
CREATE INDEX "guests_tenant_id_idx" ON "guests"("tenant_id");

-- CreateIndex
CREATE INDEX "guests_session_id_idx" ON "guests"("session_id");

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "dining_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- qr-self-order/CAP-1 (AD-17): one open session per table at a time. Partial
-- unique index (same convention as shifts_one_open_per_outlet in
-- 20260825000000_shift_cash_management) - the actual guarantee under a
-- concurrent double-start race; guest/sessions/sessions.service.ts also
-- pre-checks for a friendlier 409, but a race falls back on this index
-- raising a unique-violation the service catches and reports the same way.
CREATE UNIQUE INDEX "table_sessions_one_open_per_table" ON "table_sessions"("table_id") WHERE "status" = 'open';

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "table_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "table_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "table_sessions"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "table_sessions" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "guests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "guests"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "guests" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

-- Guest entry (AD-17, SPEC qr-self-order Constraints): a scanned QR carries
-- outlet + table ids but no tenant id (SPEC Assumptions - the URL pattern is
-- just those two ids), so guest/sessions/sessions.service.ts must resolve the
-- owning tenant from the outlet/table row BEFORE app.tenant_id can be set -
-- the same chicken-and-egg admin/auth.service.ts's acceptInvite already
-- solves for owner_invites (see invite_accept_read in
-- 20260824600000_tenant_admin_owner_invite_checklist), extended here to the
-- two rows a guest needs to read pre-auth. This is a narrow, additional
-- permissive SELECT policy (Postgres OR's multiple permissive policies
-- together) - it never widens INSERT/UPDATE/DELETE, which still require the
-- real app.tenant_id via tenant_isolation above. Outlet/table ids are not
-- secret (they are literally printed in the table's QR code), so this is not
-- a new information disclosure - the session PIN, not table/outlet identity,
-- is what gates joining a cart.
CREATE POLICY "guest_entry_read" ON "outlets" FOR SELECT
  USING (current_setting('app.guest_entry_context', true) = 'guest');
CREATE POLICY "guest_entry_read" ON "dining_tables" FOR SELECT
  USING (current_setting('app.guest_entry_context', true) = 'guest');
