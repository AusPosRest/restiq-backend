-- CreateEnum
CREATE TYPE "PriceChannel" AS ENUM ('dine_in', 'takeaway', 'delivery', 'qr', 'aggregator');

-- DropIndex
DROP INDEX "item_prices_item_id_created_at_idx";

-- AlterTable
ALTER TABLE "item_prices" ADD COLUMN     "channel" "PriceChannel",
ADD COLUMN     "effective_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "outlet_id" UUID,
ADD COLUMN     "variant_id" UUID;

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "available" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "item_variants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_selections" INTEGER NOT NULL,
    "max_selections" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_minor" BIGINT NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_modifier_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "item_modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allergens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allergens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_allergens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "allergen_id" UUID NOT NULL,

    CONSTRAINT "item_allergens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "name" TEXT NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_components" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "combo_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "combo_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_outlet_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "available" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "item_outlet_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "item_variants_item_id_name_key" ON "item_variants"("item_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_groups_tenant_id_name_key" ON "modifier_groups"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "modifiers_group_id_name_key" ON "modifiers"("group_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "item_modifier_groups_item_id_group_id_key" ON "item_modifier_groups"("item_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "allergens_tenant_id_name_key" ON "allergens"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "item_allergens_item_id_allergen_id_key" ON "item_allergens"("item_id", "allergen_id");

-- CreateIndex
CREATE UNIQUE INDEX "combos_tenant_id_name_key" ON "combos"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "combo_components_combo_id_item_id_key" ON "combo_components"("combo_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_outlet_overrides_item_id_outlet_id_key" ON "item_outlet_overrides"("item_id", "outlet_id");

-- CreateIndex
CREATE INDEX "item_prices_item_id_variant_id_effective_at_idx" ON "item_prices"("item_id", "variant_id", "effective_at");

-- AddForeignKey
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_variants" ADD CONSTRAINT "item_variants_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "item_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_modifier_groups" ADD CONSTRAINT "item_modifier_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_modifier_groups" ADD CONSTRAINT "item_modifier_groups_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_modifier_groups" ADD CONSTRAINT "item_modifier_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allergens" ADD CONSTRAINT "allergens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_allergens" ADD CONSTRAINT "item_allergens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_allergens" ADD CONSTRAINT "item_allergens_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_allergens" ADD CONSTRAINT "item_allergens_allergen_id_fkey" FOREIGN KEY ("allergen_id") REFERENCES "allergens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combos" ADD CONSTRAINT "combos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combos" ADD CONSTRAINT "combos_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_outlet_overrides" ADD CONSTRAINT "item_outlet_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_outlet_overrides" ADD CONSTRAINT "item_outlet_overrides_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_outlet_overrides" ADD CONSTRAINT "item_outlet_overrides_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table:
-- tenant_isolation covers SELECT/INSERT/UPDATE/DELETE under app.tenant_id,
-- operator_read is a cross-tenant SELECT for the ops console. item_prices
-- itself keeps its story-2 append-only policies unchanged - these new
-- columns don't need new policies, RLS is row-scoped by tenant_id only.
ALTER TABLE "item_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_variants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "item_variants"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "item_variants" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "modifier_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "modifier_groups"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "modifier_groups" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "modifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "modifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "modifiers"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "modifiers" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "item_modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_modifier_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "item_modifier_groups"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "item_modifier_groups" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "allergens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "allergens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "allergens"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "allergens" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "item_allergens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_allergens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "item_allergens"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "item_allergens" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "combos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combos" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "combos"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "combos" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "combo_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combo_components" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "combo_components"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "combo_components" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "item_outlet_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_outlet_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "item_outlet_overrides"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "item_outlet_overrides" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

