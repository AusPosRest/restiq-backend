-- Owner password reset by email (restiq-backend#181) and owner sessions that can be revoked.
ALTER TABLE "owner_users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "owner_password_resets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    -- Only the hash is stored; the raw token travels in the emailed link.
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "owner_password_resets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "owner_password_resets_token_hash_key" ON "owner_password_resets"("token_hash");
CREATE INDEX "owner_password_resets_tenant_id_idx" ON "owner_password_resets"("tenant_id");
CREATE INDEX "owner_password_resets_owner_id_idx" ON "owner_password_resets"("owner_id");
ALTER TABLE "owner_password_resets" ADD CONSTRAINT "owner_password_resets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "owner_password_resets" ADD CONSTRAINT "owner_password_resets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owner_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "owner_password_resets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "owner_password_resets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "owner_password_resets"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Asking for a reset and using the link both happen before any tenant is known (only an email, or
-- only the token). Each runs inside one transaction that sets this context for the lookup and the
-- write of that one row, the same shape as invite_accept_read and owner_login_read.
CREATE POLICY "reset_flow" ON "owner_password_resets"
  USING (current_setting('app.password_reset_context', true) = 'reset')
  WITH CHECK (current_setting('app.password_reset_context', true) = 'reset');
