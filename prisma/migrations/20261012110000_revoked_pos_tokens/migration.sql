-- #242: revoke one POS session while keeping the staff member's other devices signed in.
CREATE TABLE "revoked_pos_tokens" (
  "jti" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "revoked_pos_tokens_pkey" PRIMARY KEY ("jti"),
  CONSTRAINT "revoked_pos_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "revoked_pos_tokens_tenant_id_idx" ON "revoked_pos_tokens"("tenant_id");
ALTER TABLE "revoked_pos_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "revoked_pos_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "revoked_pos_tokens"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "revoked_pos_tokens" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
