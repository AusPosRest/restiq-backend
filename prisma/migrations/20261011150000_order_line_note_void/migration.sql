-- restiq-backend#210: special instructions on a till line, and manager-approved
-- void of a line already sent to the kitchen (the line is kept, stamped voided).
ALTER TABLE "order_lines" ADD COLUMN "note" TEXT;
ALTER TABLE "order_lines" ADD COLUMN "voided_at" TIMESTAMPTZ(6);
ALTER TABLE "order_lines" ADD COLUMN "void_reason" TEXT;
