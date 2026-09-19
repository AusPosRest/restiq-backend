-- Combo menu (restiq-backend#160): combos are built from slots (pick N of
-- these options, or one fixed item) and can be ordered. A combo on an order
-- or guest cart is a parent line (combo_id, no item) with one child line per
-- chosen item (parent_line_id).

-- combos: photo, owner on/off, archive instead of delete.
ALTER TABLE "combos" ADD COLUMN "archived_at" TIMESTAMPTZ(6),
ADD COLUMN "available" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "photo_url" TEXT;

-- Live names stay unique per tenant; an archived combo's name can be reused.
DROP INDEX "combos_tenant_id_name_key";
CREATE UNIQUE INDEX "combos_live_name_per_tenant" ON "combos"("tenant_id", "name") WHERE "archived_at" IS NULL;

-- CreateTable
CREATE TABLE "combo_slots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "combo_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "pick_count" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "combo_slots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "combo_slots_pick_count_check" CHECK ("pick_count" >= 1)
);

-- CreateTable
CREATE TABLE "combo_slot_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "variant_id" UUID,
    "upcharge_minor" BIGINT NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "combo_slot_options_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "combo_slot_options_upcharge_check" CHECK ("upcharge_minor" >= 0)
);

CREATE INDEX "combo_slots_combo_id_idx" ON "combo_slots"("combo_id");
CREATE INDEX "combo_slot_options_slot_id_idx" ON "combo_slot_options"("slot_id");

ALTER TABLE "combo_slots" ADD CONSTRAINT "combo_slots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "combo_slots" ADD CONSTRAINT "combo_slots_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combo_slot_options" ADD CONSTRAINT "combo_slot_options_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "combo_slot_options" ADD CONSTRAINT "combo_slot_options_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "combo_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combo_slot_options" ADD CONSTRAINT "combo_slot_options_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "combo_slot_options" ADD CONSTRAINT "combo_slot_options_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "item_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Carry every existing combo component over as a fixed slot (one option).
-- The source tables force RLS, so lift FORCE for the copy - the migration
-- role owns them - and put it back straight after.
ALTER TABLE "combo_components" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "menu_items" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "combo_slots" ("id", "tenant_id", "combo_id", "name", "pick_count", "sort_order")
SELECT cc."id", cc."tenant_id", cc."combo_id", mi."name", cc."quantity",
       (ROW_NUMBER() OVER (PARTITION BY cc."combo_id" ORDER BY cc."id") - 1)::int
FROM "combo_components" cc JOIN "menu_items" mi ON mi."id" = cc."item_id";

INSERT INTO "combo_slot_options" ("id", "tenant_id", "slot_id", "item_id", "variant_id", "upcharge_minor", "sort_order")
SELECT gen_random_uuid(), cc."tenant_id", cc."id", cc."item_id", NULL, 0, 0
FROM "combo_components" cc;

ALTER TABLE "menu_items" FORCE ROW LEVEL SECURITY;

DROP TABLE "combo_components";

ALTER TABLE "combo_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combo_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "combo_slots"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "combo_slots" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "combo_slot_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combo_slot_options" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "combo_slot_options"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "combo_slot_options" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

-- Order and cart lines: a line is either an item or a combo parent.
ALTER TABLE "order_lines" ADD COLUMN "combo_id" UUID, ADD COLUMN "parent_line_id" UUID, ALTER COLUMN "item_id" DROP NOT NULL;
ALTER TABLE "cart_lines" ADD COLUMN "combo_id" UUID, ADD COLUMN "parent_line_id" UUID, ADD COLUMN "combo_option_id" UUID, ALTER COLUMN "item_id" DROP NOT NULL;
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_item_or_combo_check" CHECK (("item_id" IS NULL) <> ("combo_id" IS NULL));
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_item_or_combo_check" CHECK (("item_id" IS NULL) <> ("combo_id" IS NULL));

CREATE INDEX "order_lines_parent_line_id_idx" ON "order_lines"("parent_line_id");
CREATE INDEX "cart_lines_parent_line_id_idx" ON "cart_lines"("parent_line_id");

ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_parent_line_id_fkey" FOREIGN KEY ("parent_line_id") REFERENCES "order_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_parent_line_id_fkey" FOREIGN KEY ("parent_line_id") REFERENCES "cart_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
