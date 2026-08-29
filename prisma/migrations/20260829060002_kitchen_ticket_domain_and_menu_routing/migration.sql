-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('queued', 'bumped');

-- CreateEnum
CREATE TYPE "TicketEventType" AS ENUM ('bumped', 'recalled', 'refired', 'add_on_fired');

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "station_id" UUID;

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "station_id" UUID,
    "status" "TicketStatus" NOT NULL DEFAULT 'queued',
    "recall_count" INTEGER NOT NULL DEFAULT 0,
    "fired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bumped_at" TIMESTAMPTZ(6),
    "recalled_at" TIMESTAMPTZ(6),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "add_on_batch" INTEGER NOT NULL DEFAULT 0,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "type" "TicketEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tickets_tenant_id_idx" ON "tickets"("tenant_id");

-- CreateIndex
CREATE INDEX "tickets_outlet_id_station_id_status_idx" ON "tickets"("outlet_id", "station_id", "status");

-- CreateIndex
CREATE INDEX "tickets_order_id_idx" ON "tickets"("order_id");

-- CreateIndex
CREATE INDEX "ticket_lines_tenant_id_idx" ON "ticket_lines"("tenant_id");

-- CreateIndex
CREATE INDEX "ticket_lines_ticket_id_idx" ON "ticket_lines"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_lines_ticket_id_order_line_id_key" ON "ticket_lines"("ticket_id", "order_line_id");

-- CreateIndex
CREATE INDEX "ticket_events_tenant_id_idx" ON "ticket_events"("tenant_id");

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_idx" ON "ticket_events"("ticket_id");

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tickets"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "tickets" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "ticket_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ticket_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "ticket_lines" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "ticket_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ticket_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "ticket_events" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
