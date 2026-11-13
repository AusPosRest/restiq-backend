-- restiq-backend#301 (HUB-BUILD-PLAN B4): the LAN addresses a hub till
-- announces, so the outlet's other devices can find it.
ALTER TABLE "devices" ADD COLUMN "lan_urls" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "devices" ADD COLUMN "lan_announced_at" TIMESTAMPTZ(6);
