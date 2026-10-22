-- scripts/init-timescaledb.sql
-- Runs automatically when the TimescaleDB container initializes for the first time.
-- This file is mounted into /docker-entrypoint-initdb.d/ and executed by the postgres entrypoint.

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- NOTE: The telemetry_records table is created by `prisma db push` or `prisma migrate deploy`.
-- This script converts it to a hypertable IF the table already exists.
-- If the table doesn't exist yet, this is a no-op (the DO block handles it gracefully).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'telemetry_records'
  ) THEN
    PERFORM create_hypertable(
      'telemetry_records', 'time',
      if_not_exists => TRUE,
      migrate_data  => TRUE
    );
    RAISE NOTICE 'TimescaleDB: telemetry_records hypertable ready';
  ELSE
    RAISE NOTICE 'TimescaleDB: telemetry_records table does not exist yet (will be created by Prisma)';
  END IF;
END
$$;
