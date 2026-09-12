-- Kiosk ordering (issue #138): a guest session may have no table (the kiosk
-- device stands in for it) and the order it places is a third source. The
-- one-open-session-per-table partial unique index is unaffected - Postgres
-- treats every NULL table_id as distinct, so any number of kiosk sessions
-- can be open at once.
ALTER TABLE "table_sessions" ALTER COLUMN "table_id" DROP NOT NULL;
ALTER TYPE "OrderSource" ADD VALUE 'kiosk';
