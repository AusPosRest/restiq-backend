-- DocuSign e-signature for platform agreements (issue #150). An envelope is
-- one signing attempt: the owner signs embedded in their console, then the
-- platform's authorised signatory countersigns by email. When DocuSign
-- reports it completed, the sealed PDF (with DocuSign's Certificate of
-- Completion) is stored on the agreement_signatures row it produces.
CREATE TABLE "agreement_envelopes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agreement_version_id" UUID NOT NULL,
    "envelope_id" TEXT NOT NULL,
    "signer_owner_id" UUID NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_email" TEXT NOT NULL,
    "signer_title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "owner_signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_envelopes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agreement_envelopes_status_check" CHECK ("status" IN ('sent', 'completed', 'declined', 'voided'))
);

CREATE UNIQUE INDEX "agreement_envelopes_envelope_id_key" ON "agreement_envelopes"("envelope_id");
CREATE INDEX "agreement_envelopes_tenant_id_idx" ON "agreement_envelopes"("tenant_id");
-- One signing attempt in flight per tenant per version.
CREATE UNIQUE INDEX "agreement_envelopes_one_open_key" ON "agreement_envelopes"("tenant_id", "agreement_version_id") WHERE "status" = 'sent';

ALTER TABLE "agreement_envelopes" ADD CONSTRAINT "agreement_envelopes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agreement_envelopes" ADD CONSTRAINT "agreement_envelopes_agreement_version_id_fkey" FOREIGN KEY ("agreement_version_id") REFERENCES "agreement_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agreement_envelopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agreement_envelopes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "agreement_envelopes"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "agreement_envelopes" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

-- Signatures made through DocuSign carry the signer's title, the envelope and
-- the sealed PDF; the typed-name signatures from #132 keep these NULL.
ALTER TABLE "agreement_signatures" ADD COLUMN "signer_title" TEXT;
ALTER TABLE "agreement_signatures" ADD COLUMN "envelope_id" TEXT;
ALTER TABLE "agreement_signatures" ADD COLUMN "signed_pdf" BYTEA;
