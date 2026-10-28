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

    -- Enable TimescaleDB Native Columnar Compression
    BEGIN
      ALTER TABLE "telemetry_records" SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = '"organizationId", imei',
        timescaledb.compress_orderby = 'time DESC'
      );
      RAISE NOTICE 'TimescaleDB: Columnar compression enabled for telemetry_records';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'TimescaleDB: Compression already enabled or notice: %', SQLERRM;
    END;

    -- Add automated compression policy (compress chunks older than 2 days)
    BEGIN
      PERFORM add_compression_policy('telemetry_records', INTERVAL '2 days', if_not_exists => TRUE);
      RAISE NOTICE 'TimescaleDB: Compression policy (2 days) configured';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'TimescaleDB: Compression policy notice: %', SQLERRM;
    END;

    -- Add automated retention policy (retain raw telemetry for 90 days)
    BEGIN
      PERFORM add_retention_policy('telemetry_records', INTERVAL '90 days', if_not_exists => TRUE);
      RAISE NOTICE 'TimescaleDB: Retention policy (90 days) configured';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'TimescaleDB: Retention policy notice: %', SQLERRM;
    END;

  ELSE
    RAISE NOTICE 'TimescaleDB: telemetry_records table does not exist yet (will be created by Prisma)';
  END IF;
END
$$;
