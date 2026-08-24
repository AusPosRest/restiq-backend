-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('pos', 'kds', 'kiosk', 'cds');

-- CreateEnum
CREATE TYPE "DeviceRole" AS ENUM ('terminal', 'hub');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('active', 'revoked');

-- CreateTable (control plane, AD-7: no tenant_id, no RLS - same posture as
-- operator_users / control_plane_audit_events)
CREATE TABLE "applied_ops" (
    "op_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applied_ops_pkey" PRIMARY KEY ("op_id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID,
    "label" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL,
    "role" "DeviceRole" NOT NULL DEFAULT 'terminal',
    "status" "DeviceStatus" NOT NULL DEFAULT 'active',
    "hardware_key_fingerprint" TEXT NOT NULL,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrolment_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "device_type" "DeviceType" NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrolment_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_dead_letters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "op_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT NOT NULL,
    "payload_meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "devices_tenant_id_idx" ON "devices"("tenant_id");

-- CreateIndex
CREATE INDEX "devices_outlet_id_idx" ON "devices"("outlet_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrolment_codes_code_hash_key" ON "enrolment_codes"("code_hash");

-- CreateIndex
CREATE INDEX "enrolment_codes_tenant_id_idx" ON "enrolment_codes"("tenant_id");

-- CreateIndex
CREATE INDEX "sync_dead_letters_tenant_id_idx" ON "sync_dead_letters"("tenant_id");

-- CreateIndex
CREATE INDEX "sync_dead_letters_device_id_idx" ON "sync_dead_letters"("device_id");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_dead_letters" ADD CONSTRAINT "sync_dead_letters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_dead_letters" ADD CONSTRAINT "sync_dead_letters_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security (AD-5), same posture as every other tenant-owned table:
-- tenant_isolation for reads/writes under app.tenant_id, operator_read for
-- the console's explicit cross-tenant read context.
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "devices"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "devices" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "enrolment_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrolment_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "enrolment_codes"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "enrolment_codes" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

-- Append-only (AD-6): no UPDATE/DELETE grants beyond what RLS already scopes
-- - resolvedAt is the only field ever mutated, and only from the DLQ story.
ALTER TABLE "sync_dead_letters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_dead_letters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sync_dead_letters"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "sync_dead_letters" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
