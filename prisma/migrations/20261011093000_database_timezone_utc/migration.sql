-- restiq-backend#209 (SE-31): Prisma's Postgres adapter sends timestamps as UTC wall-clock time with no offset,
-- so a session whose TimeZone isn't UTC (e.g. a database defaulting to Asia/Kolkata) stored them hours early,
-- out of step with SQL now(). Every new session of this database now runs in UTC. Set on the database rather
-- than as a connection startup option, which a pooled (PgBouncer) connection string can refuse.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
