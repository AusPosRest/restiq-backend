-- restiq-web#248: owners can delete (archive) a menu item. Order and cart
-- lines keep pointing at it, so the row stays and every menu read filters
-- on archived_at.
ALTER TABLE "menu_items" ADD COLUMN "archived_at" TIMESTAMPTZ(6);

-- A deleted item's name must be reusable, so one-name-per-category only
-- covers live items. Prisma's schema DSL has no partial-index syntax (same
-- as shifts_one_open_per_outlet), so the index lives here, not in schema.prisma.
ALTER TABLE "menu_items" DROP CONSTRAINT "menu_items_tenant_id_category_id_name_key";
CREATE UNIQUE INDEX "menu_items_live_name_per_category" ON "menu_items"("tenant_id", "category_id", "name") WHERE "archived_at" IS NULL;
