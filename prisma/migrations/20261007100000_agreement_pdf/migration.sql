-- An agreement is an uploaded PDF (restiq-backend#179), not text. The text body is kept only for
-- versions published before this change; they have no file and cannot be signed.
ALTER TABLE agreement_versions ALTER COLUMN body DROP NOT NULL;
ALTER TABLE agreement_versions RENAME COLUMN body_sha256 TO file_sha256;
ALTER TABLE agreement_versions ADD COLUMN pdf bytea, ADD COLUMN file_name text, ADD COLUMN size_bytes integer;
