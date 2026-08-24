-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "operator_users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operator_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane_audit_events" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_plane_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_users_email_key" ON "operator_users"("email");

