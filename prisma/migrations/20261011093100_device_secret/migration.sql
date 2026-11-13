-- restiq-backend#209 (SE-12): a device proves it is the enrolled device with a secret it got at enrolment (only its hash is kept).
ALTER TABLE "devices" ADD COLUMN "secret_hash" TEXT;
