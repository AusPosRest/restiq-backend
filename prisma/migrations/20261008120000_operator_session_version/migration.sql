-- restiq-backend#203: logout ends every session of an operator, same pattern as OwnerUser (#181)
ALTER TABLE "operator_users" ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
