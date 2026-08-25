-- CreateEnum
CREATE TYPE "ClockEventType" AS ENUM ('clock_in', 'clock_out');

-- CreateTable
CREATE TABLE "clock_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "type" "ClockEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clock_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clock_events_tenant_id_idx" ON "clock_events"("tenant_id");

-- CreateIndex
CREATE INDEX "clock_events_staff_id_occurred_at_idx" ON "clock_events"("staff_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "clock_events" ADD CONSTRAINT "clock_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_events" ADD CONSTRAINT "clock_events_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_events" ADD CONSTRAINT "clock_events_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "clock_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clock_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "clock_events"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "clock_events" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
