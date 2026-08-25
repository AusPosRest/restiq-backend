-- pos/CAP-4 group ordering (issue #58): nullable at the DB level for
-- migration safety (existing rows have no seat assigned); the "every line
-- must be seated before an order can be sent" rule is application-enforced,
-- not a DB constraint - see pos/orders/orders.service.ts's updateStatus.
ALTER TABLE "order_lines" ADD COLUMN "seat_number" INTEGER;
