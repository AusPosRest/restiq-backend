-- CreateEnum
CREATE TYPE "TableShape" AS ENUM ('circle', 'square', 'rectangle');

-- CreateEnum
CREATE TYPE "PrinterRenderMode" AS ENUM ('text', 'bitmap');

-- CreateTable
CREATE TABLE "floors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dining_tables" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "floor_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "shape" "TableShape" NOT NULL,
    "seat_capacity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dining_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "render_mode" "PrinterRenderMode" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ageing_threshold_minutes" INTEGER NOT NULL,
    "primary_printer_id" UUID,
    "fallback_printer_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "floors_tenant_id_idx" ON "floors"("tenant_id");

-- CreateIndex
CREATE INDEX "floors_outlet_id_idx" ON "floors"("outlet_id");

-- CreateIndex
CREATE INDEX "dining_tables_tenant_id_idx" ON "dining_tables"("tenant_id");

-- CreateIndex
CREATE INDEX "dining_tables_floor_id_idx" ON "dining_tables"("floor_id");

-- CreateIndex
CREATE INDEX "printers_tenant_id_idx" ON "printers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "printers_outlet_id_name_key" ON "printers"("outlet_id", "name");

-- CreateIndex
CREATE INDEX "stations_tenant_id_idx" ON "stations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stations_outlet_id_name_key" ON "stations"("outlet_id", "name");

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printers" ADD CONSTRAINT "printers_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_primary_printer_id_fkey" FOREIGN KEY ("primary_printer_id") REFERENCES "printers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_fallback_printer_id_fkey" FOREIGN KEY ("fallback_printer_id") REFERENCES "printers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "floors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "floors" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "floors"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "floors" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "dining_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dining_tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "dining_tables"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "dining_tables" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "printers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "printers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "printers"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "printers" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "stations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stations"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "stations" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

