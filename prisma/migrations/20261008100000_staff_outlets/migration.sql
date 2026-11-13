-- Assign staff to outlets (restiq-backend#197). Empty = every outlet, so staff created before this keep
-- signing in everywhere. Outlets are soft-deleted only, so a plain id array needs no foreign key.
ALTER TABLE "staff_users" ADD COLUMN "outlet_ids" UUID[] NOT NULL DEFAULT '{}';
