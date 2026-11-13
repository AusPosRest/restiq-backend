-- restiq-backend#292: the hub keeps its own tenants and brands rows, so changes
-- to them (status, Live/Test mode, offline limit, name) go into the change feed
-- too. A tenants row is its own tenant: it has no tenant_id column, only id.
CREATE OR REPLACE FUNCTION sync_record_change() RETURNS trigger AS $$
DECLARE
  r jsonb;
  prior text;
  outlet uuid;
  tenant text;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  -- An outlet row is scoped to itself; other rows to their outlet_id, if any.
  IF TG_TABLE_NAME = 'outlets' THEN
    outlet := (r->>'id')::uuid;
  ELSE
    outlet := NULLIF(r->>'outlet_id', '')::uuid;
  END IF;
  IF TG_TABLE_NAME = 'tenants' THEN tenant := r->>'id'; ELSE tenant := r->>'tenant_id'; END IF;
  prior := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', tenant, true);
  INSERT INTO "sync_changes" ("tenant_id", "outlet_id", "entity", "entity_id", "action")
  VALUES (tenant::uuid, outlet, TG_TABLE_NAME, (r->>'id')::uuid,
          CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  PERFORM set_config('app.tenant_id', COALESCE(prior, ''), true);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_record_change AFTER INSERT OR UPDATE OR DELETE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION sync_record_change();
CREATE TRIGGER sync_record_change AFTER INSERT OR UPDATE OR DELETE ON "brands"
  FOR EACH ROW EXECUTE FUNCTION sync_record_change();
