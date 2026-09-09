-- Platform agreements (issue #132): immutable numbered versions published by
-- operators (no tenant_id, no RLS - every tenant reads the same text) and
-- one owner signature per tenant per version (RLS mirrors print_jobs).
CREATE TABLE "agreement_versions" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "body_sha256" TEXT NOT NULL,
    "published_by" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agreement_versions_version_key" ON "agreement_versions"("version");

CREATE TABLE "agreement_signatures" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agreement_version_id" UUID NOT NULL,
    "signer_owner_id" UUID NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "evidence_sha256" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agreement_signatures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agreement_signatures_tenant_id_agreement_version_id_key" ON "agreement_signatures"("tenant_id", "agreement_version_id");
CREATE INDEX "agreement_signatures_tenant_id_idx" ON "agreement_signatures"("tenant_id");

ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_agreement_version_id_fkey" FOREIGN KEY ("agreement_version_id") REFERENCES "agreement_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agreement_signatures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agreement_signatures" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agreement_signatures"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "agreement_signatures" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
