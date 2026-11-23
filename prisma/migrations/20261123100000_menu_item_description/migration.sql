-- restiq-backend#318 (restiq-web#385): an optional short dish description,
-- written by the owner's menu editor and shown on the guest QR menu.
ALTER TABLE "menu_items" ADD COLUMN "description" TEXT;
