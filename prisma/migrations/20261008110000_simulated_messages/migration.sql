-- Simulated mail inbox (restiq-backend#198): with MAIL_PROVIDER=simulator every email the platform sends
-- is kept here for the dev inbox instead of leaving the building. Platform-level, no tenant column.
CREATE TABLE "simulated_messages" (
    "id" UUID NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "simulated_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "simulated_messages_created_at_idx" ON "simulated_messages"("created_at");
