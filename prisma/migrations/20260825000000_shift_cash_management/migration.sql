-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('paid_out', 'bank_drop');

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outlet_id" UUID NOT NULL,
    "opened_by_staff_id" UUID NOT NULL,
    "float_minor" BIGINT NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_staff_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "counted_minor" BIGINT,
    "expected_minor" BIGINT,
    "over_short_minor" BIGINT,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shifts_tenant_id_idx" ON "shifts"("tenant_id");

-- CreateIndex
CREATE INDEX "shifts_outlet_id_idx" ON "shifts"("outlet_id");

-- CreateIndex
CREATE INDEX "cash_movements_tenant_id_idx" ON "cash_movements"("tenant_id");

-- CreateIndex
CREATE INDEX "cash_movements_shift_id_idx" ON "cash_movements"("shift_id");

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_outlet_id_fkey" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opened_by_staff_id_fkey" FOREIGN KEY ("opened_by_staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_staff_id_fkey" FOREIGN KEY ("closed_by_staff_id") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_created_by_staff_id_fkey" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CAP-10: one open shift per outlet at a time. Partial unique index (Prisma's
-- schema DSL has no partial-index syntax, same reason RLS policies below
-- live in hand-written SQL rather than schema.prisma) - this is the actual
-- guarantee under a concurrent double-open race; shifts.service.ts also
-- pre-checks for a friendlier 409, but a race falls back on this index
-- raising a unique-violation the service catches and reports the same way.
CREATE UNIQUE INDEX "shifts_one_open_per_outlet" ON "shifts"("outlet_id") WHERE "closed_at" IS NULL;

-- Row-level security (AD-5), same posture as every other tenant-owned table.
ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shifts"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "shifts" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "cash_movements"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "cash_movements" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
