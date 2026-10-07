-- Product directory (issue #153): platform-wide products operators curate and
-- tenants copy into their own menu. No tenant_id, no RLS (same as
-- agreement_versions) - every tenant reads the same rows.
CREATE TABLE "catalog_products" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "name_hindi" TEXT,
    "veg_marker" "VegMarker",
    "photo_url" TEXT,
    "category" TEXT NOT NULL,
    "suggested_price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_products_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalog_products_currency_idx" ON "catalog_products"("currency");
