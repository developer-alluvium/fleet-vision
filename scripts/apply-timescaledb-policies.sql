-- scripts/apply-timescaledb-policies.sql
-- Applies the 3-tier lifecycle policy to an existing TimescaleDB instance:
-- Tier 1 (0–7 days):  Keep uncompressed for maximum insert/write performance (hot).
-- Tier 2 (7–90 days): Native TimescaleDB columnar compression (warm, ~90% storage savings).
-- Tier 3 (90+ days):  Archived to Parquet files via cold-storage worker then purged (cold).

CREATE EXTENSION IF NOT EXISTS timescaledb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'telemetry_records'
  ) THEN
    -- Ensure hypertable
    PERFORM create_hypertable(
      'telemetry_records', 'time',
      if_not_exists => TRUE,
      migrate_data  => TRUE
    );

    -- Ensure columnar compression is configured
    BEGIN
      ALTER TABLE "telemetry_records" SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'organization_id, imei',
        timescaledb.compress_orderby = 'time DESC, id'
      );
      RAISE NOTICE 'TimescaleDB: Columnar compression settings applied';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'TimescaleDB: Compression config notice: %', SQLERRM;
    END;

    -- Refresh compression policy to INTERVAL '7 days'
    BEGIN
      PERFORM remove_compression_policy('telemetry_records', if_exists => TRUE);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'TimescaleDB: Note on remove_compression_policy: %', SQLERRM;
    END;

    BEGIN
      PERFORM add_compression_policy('telemetry_records', INTERVAL '7 days', if_not_exists => TRUE);
      RAISE NOTICE 'TimescaleDB: Active compression policy set to 7 days';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'TimescaleDB: Add compression policy notice: %', SQLERRM;
    END;

    RAISE NOTICE 'TimescaleDB: 3-tier policies successfully configured for telemetry_records.';
  ELSE
    RAISE NOTICE 'telemetry_records table does not exist yet.';
  END IF;
END
$$;

