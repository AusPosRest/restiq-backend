-- CAP-3 AI-assisted menu import.
--
-- AD-11: price moves off menu_items and into a new insert-only item_prices
-- table - no writer, including the story-1 sample-menu seed, may UPDATE a
-- price value again. menu_items is currently empty in every deployed
-- environment (checked before writing this migration), so the column swap
-- needs no backfill.
ALTER TABLE "menu_items" DROP COLUMN "price_minor";
ALTER TABLE "menu_items" DROP COLUMN "currency";
ALTER TABLE "menu_items" ADD COLUMN "short_name" TEXT NOT NULL;
ALTER TABLE "menu_items" ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- No two items in the same category may share a name - also the natural
-- forced-failure anchor for the menu-import commit atomicity test (a draft
-- with a duplicate item name in one category rolls back cleanly).
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_category_id_name_key" UNIQUE ("tenant_id", "category_id", "name");

-- CreateEnum
CREATE TYPE "MenuImportStatus" AS ENUM ('draft', 'committed');

-- CreateTable
CREATE TABLE "item_prices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_import_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "MenuImportStatus" NOT NULL DEFAULT 'draft',
    "source_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "committed_at" TIMESTAMPTZ(6),

    CONSTRAINT "menu_import_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "item_prices_item_id_created_at_idx" ON "item_prices"("item_id", "created_at");

-- CreateIndex
CREATE INDEX "menu_import_drafts_tenant_id_idx" ON "menu_import_drafts"("tenant_id");

-- AddForeignKey
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_import_drafts" ADD CONSTRAINT "menu_import_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security (AD-5).
ALTER TABLE "menu_import_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "menu_import_drafts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "menu_import_drafts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "menu_import_drafts" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

-- item_prices: append-only (AD-11) - INSERT under tenant context, SELECT for
-- tenant and operator contexts, no UPDATE/DELETE policy at all (same posture
-- as audit_events - forced RLS with no update/delete grant makes the price
-- history physically append-only, not just a convention).
ALTER TABLE "item_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "item_price_insert" ON "item_prices" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "item_price_read_tenant" ON "item_prices" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "item_price_read_operator" ON "item_prices" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
