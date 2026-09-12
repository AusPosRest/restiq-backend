-- Device topology (issue #134): a printer or card terminal can be linked to
-- one POS device; print jobs and payment intents then target that linked
-- peripheral. Null everywhere means "the whole outlet" - today's behaviour.
-- New columns on tables that already carry RLS, so no new policies.
ALTER TABLE "devices" ADD COLUMN "paired_pos_id" UUID;
ALTER TABLE "print_jobs" ADD COLUMN "target_device_id" UUID;
ALTER TABLE "payment_intents" ADD COLUMN "target_device_id" UUID;

-- CreateIndex
CREATE INDEX "devices_paired_pos_id_idx" ON "devices"("paired_pos_id");

-- CreateIndex
CREATE INDEX "print_jobs_target_device_id_idx" ON "print_jobs"("target_device_id");

-- CreateIndex
CREATE INDEX "payment_intents_target_device_id_idx" ON "payment_intents"("target_device_id");

-- AddForeignKey (SET NULL: deleting a device falls its links and queued work back to outlet-wide)
ALTER TABLE "devices" ADD CONSTRAINT "devices_paired_pos_id_fkey" FOREIGN KEY ("paired_pos_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_target_device_id_fkey" FOREIGN KEY ("target_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_target_device_id_fkey" FOREIGN KEY ("target_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
