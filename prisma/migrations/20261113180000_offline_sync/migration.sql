-- Offline sync for the Windows hub till (restiq-backend#185, docs/SYNC-DESIGN.md).

-- Device key and sync position.
ALTER TABLE "devices" ADD COLUMN "public_key" TEXT;
ALTER TABLE "devices" ADD COLUMN "last_sync_at" TIMESTAMPTZ(6);
ALTER TABLE "devices" ADD COLUMN "last_applied_seq" INTEGER NOT NULL DEFAULT 0;

-- Offline lock limit per restaurant (decision O1: 24 hours).
ALTER TABLE "tenants" ADD COLUMN "max_offline_hours" INTEGER NOT NULL DEFAULT 24;

-- The AD-7 ledger doubles as the push idempotency ledger.
ALTER TABLE "applied_ops" ADD COLUMN "device_id" UUID;
ALTER TABLE "applied_ops" ADD COLUMN "seq" INTEGER;
ALTER TABLE "applied_ops" ADD COLUMN "status" TEXT;
ALTER TABLE "applied_ops" ADD COLUMN "code" TEXT;

-- Change feed.
CREATE TABLE "sync_changes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sync_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sync_changes_tenant_id_id_idx" ON "sync_changes"("tenant_id", "id");

ALTER TABLE "sync_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sync_changes"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- One trigger function for every cloud-owned table. Some of these rows are
-- written in operator context (tenant provisioning, ops menu tools) where
-- app.tenant_id is not set, so the function sets it to the row's own tenant
-- for its one insert and puts the previous value back: the policy above stays
-- strict and the caller's context is unchanged.
CREATE FUNCTION sync_record_change() RETURNS trigger AS $$
DECLARE
  r jsonb;
  prior text;
  outlet uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  -- An outlet row is scoped to itself; other rows to their outlet_id, if any.
  IF TG_TABLE_NAME = 'outlets' THEN
    outlet := (r->>'id')::uuid;
  ELSE
    outlet := NULLIF(r->>'outlet_id', '')::uuid;
  END IF;
  prior := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', r->>'tenant_id', true);
  INSERT INTO "sync_changes" ("tenant_id", "outlet_id", "entity", "entity_id", "action")
  VALUES ((r->>'tenant_id')::uuid, outlet, TG_TABLE_NAME, (r->>'id')::uuid,
          CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  PERFORM set_config('app.tenant_id', COALESCE(prior, ''), true);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outlets', 'menu_categories', 'menu_items', 'item_variants', 'item_prices',
    'modifier_groups', 'modifiers', 'item_modifier_groups', 'combos', 'combo_slots',
    'combo_slot_options', 'item_outlet_overrides', 'floors', 'dining_tables', 'stations',
    'roles', 'staff_users', 'tenant_tax_registrations', 'printers'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER sync_record_change AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION sync_record_change()', t);
  END LOOP;
END $$;
