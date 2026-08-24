-- CreateEnum
CREATE TYPE "TenantLifecycle" AS ENUM ('provisioning', 'active', 'deleted');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('provisioning', 'active');

-- CreateEnum
CREATE TYPE "Country" AS ENUM ('IN', 'AU');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('standard', 'enterprise');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('monthly', 'annual');

-- CreateEnum
CREATE TYPE "TaxRegistrationType" AS ENUM ('gstin', 'abn');

-- CreateEnum
CREATE TYPE "OutletType" AS ENUM ('dine_in', 'qsr', 'cloud_kitchen', 'food_court');

-- CreateTable
CREATE TABLE "tenant_registry" (
    "tenant_id" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "lifecycle" "TenantLifecycle" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_registry_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "onboarding_drafts" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "steps" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "onboarding_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "registered_address" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "country" "Country" NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'provisioning',
    "plan" "SubscriptionPlan" NOT NULL,
    "billing_period" "BillingPeriod" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_tax_registrations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "registration_type" "TaxRegistrationType" NOT NULL,
    "registration_number" TEXT NOT NULL,
    "legal_entity_name" TEXT NOT NULL,
    "tax_profile" TEXT NOT NULL,
    "fssai_license" TEXT,
    "composition_scheme" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_tax_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "type" "OutletType" NOT NULL,
    "timezone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_drafts_operator_id_key" ON "onboarding_drafts"("operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_tax_registrations_registration_number_key" ON "tenant_tax_registrations"("registration_number");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_name_key" ON "roles"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "owner_invites_token_hash_key" ON "owner_invites"("token_hash");

-- AddForeignKey
ALTER TABLE "tenant_tax_registrations" ADD CONSTRAINT "tenant_tax_registrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_invites" ADD CONSTRAINT "owner_invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-level security (AD-5): forced RLS on every tenant-owned table.
--   * tenant_isolation: rows visible/writable only when app.tenant_id matches
--     (SET LOCAL inside a transaction under pooling). Unset setting => NULL
--     comparison => no rows: fail closed.
--   * operator_read: the ops console reads cross-tenant under an explicit
--     operator context - never by disabling RLS.
-- audit_events gets INSERT and SELECT policies only: with forced RLS and no
-- UPDATE/DELETE policy, the table is append-only for every non-superuser.
-- Control-plane tables (operator_users, tenant_registry, onboarding_drafts,
-- control_plane_audit_events) are the only tables without tenant_id.
-- ---------------------------------------------------------------------------

-- tenants: its id IS the tenant id.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenants"
  USING ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "tenants" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_tax_registrations', 'brands', 'outlets', 'roles',
    'menu_categories', 'menu_items', 'owner_invites'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    EXECUTE format(
      'CREATE POLICY operator_read ON %I FOR SELECT
         USING (current_setting(''app.operator_context'', true) = ''operator'')', t);
  END LOOP;
END $$;

-- audit_events: append-only (AD-6) - INSERT under tenant context, SELECT for
-- tenant and operator contexts, no UPDATE/DELETE policy at all.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_insert" ON "audit_events" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "audit_read_tenant" ON "audit_events" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "audit_read_operator" ON "audit_events" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
