-- qr-self-order/CAP-4 (issue #77, AD-18): converts a session's shared cart
-- into a real Order/OrderLine set - additive columns on the EXISTING
-- pos/CAP-2/CAP-3 tables only, never a parallel guest-order model. No new
-- tables, so RLS (already forced on both tables) needs no changes here.

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('pos', 'qr');

-- AlterTable "orders": ownerId becomes nullable (a guest-placed order has no
-- staff owner at creation - see Order.ownerId's schema comment for why this
-- is not a faked staff id), plus the source discriminator and session link.
ALTER TABLE "orders" ALTER COLUMN "owner_id" DROP NOT NULL;
ALTER TABLE "orders" ADD COLUMN "source" "OrderSource" NOT NULL DEFAULT 'pos';
ALTER TABLE "orders" ADD COLUMN "session_id" UUID;

-- CreateIndex
CREATE INDEX "orders_session_id_idx" ON "orders"("session_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable "order_lines": addedByStaffId becomes nullable (a guest-placed
-- line has no staff adder - see OrderLine.addedByStaffId's schema comment),
-- plus the per-guest label snapshot (guestId/guestName), mirroring
-- CartLine.guestId/guestName exactly so the cart-to-order conversion needs
-- no reshaping.
ALTER TABLE "order_lines" ALTER COLUMN "added_by_staff_id" DROP NOT NULL;
ALTER TABLE "order_lines" ADD COLUMN "guest_id" UUID;
ALTER TABLE "order_lines" ADD COLUMN "guest_name" TEXT;

-- CreateIndex
CREATE INDEX "order_lines_guest_id_idx" ON "order_lines"("guest_id");

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
