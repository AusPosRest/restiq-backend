-- Tenant subdomain (D14): <slug>.<BASE_DOMAIN>. Chosen when the tenant is created and never changed.
-- Nullable so tenants created before this change keep working until ops gives them an address.
ALTER TABLE "tenants" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
