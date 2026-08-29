-- CreateTable
CREATE TABLE "cart_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "guest_name" TEXT NOT NULL,
    "item_id" UUID NOT NULL,
    "variant_id" UUID,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_line_modifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cart_line_id" UUID NOT NULL,
    "modifier_id" UUID NOT NULL,

    CONSTRAINT "cart_line_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cart_lines_tenant_id_idx" ON "cart_lines"("tenant_id");

-- CreateIndex
CREATE INDEX "cart_lines_session_id_idx" ON "cart_lines"("session_id");

-- CreateIndex
CREATE INDEX "cart_lines_guest_id_idx" ON "cart_lines"("guest_id");

-- CreateIndex
CREATE INDEX "cart_line_modifiers_tenant_id_idx" ON "cart_line_modifiers"("tenant_id");

-- CreateIndex
CREATE INDEX "cart_line_modifiers_cart_line_id_idx" ON "cart_line_modifiers"("cart_line_id");

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_lines" ADD CONSTRAINT "cart_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "item_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_line_modifiers" ADD CONSTRAINT "cart_line_modifiers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_line_modifiers" ADD CONSTRAINT "cart_line_modifiers_cart_line_id_fkey" FOREIGN KEY ("cart_line_id") REFERENCES "cart_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_line_modifiers" ADD CONSTRAINT "cart_line_modifiers_modifier_id_fkey" FOREIGN KEY ("modifier_id") REFERENCES "modifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (AD-5), same posture as every other tenant-owned table
-- (see 20260829055809_guest_realm_table_sessions for the pattern this
-- repeats verbatim).
ALTER TABLE "cart_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cart_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "cart_lines"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "cart_lines" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');

ALTER TABLE "cart_line_modifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cart_line_modifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "cart_line_modifiers"
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "operator_read" ON "cart_line_modifiers" FOR SELECT
  USING (current_setting('app.operator_context', true) = 'operator');
