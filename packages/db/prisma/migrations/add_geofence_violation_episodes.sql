-- Create the episodes table
CREATE TABLE IF NOT EXISTS "geofence_violation_episodes" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "imei" TEXT NOT NULL,
  "geofence_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "started_at" TIMESTAMPTZ NOT NULL,
  "ended_at" TIMESTAMPTZ,
  "duration_sec" INTEGER,
  "limit_kmh" DOUBLE PRECISION NOT NULL,
  "peak_speed_kmh" DOUBLE PRECISION NOT NULL,
  "avg_speed_kmh" DOUBLE PRECISION,
  "start_lat" DOUBLE PRECISION NOT NULL,
  "start_lng" DOUBLE PRECISION NOT NULL,
  "peak_lat" DOUBLE PRECISION NOT NULL,
  "peak_lng" DOUBLE PRECISION NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'MINOR',
  "ping_count" INTEGER NOT NULL DEFAULT 0,
  "notified_count" INTEGER NOT NULL DEFAULT 0,
  "last_notified_at" TIMESTAMPTZ,
  "close_reason" TEXT,
  "acknowledged_by" TEXT,
  "acknowledged_at" TIMESTAMPTZ,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "geofence_violation_episodes_pkey" PRIMARY KEY ("id")
);

-- Unique index for idempotency
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "geofence_violation_episodes_imei_geofence_id_started_at_key" ON "geofence_violation_episodes"("imei", "geofence_id", "started_at");

-- Search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS "geofence_violation_episodes_organization_id_created_at_idx" ON "geofence_violation_episodes"("organization_id", "created_at" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "geofence_violation_episodes_organization_id_imei_created_at_idx" ON "geofence_violation_episodes"("organization_id", "imei", "created_at" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "geofence_violation_episodes_organization_id_geofence_id_creat_idx" ON "geofence_violation_episodes"("organization_id", "geofence_id", "created_at" DESC);

-- Partial index for OPEN episodes
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_gve_open" ON "geofence_violation_episodes"("organization_id", "imei", "geofence_id") WHERE status = 'OPEN';

-- Add foreign key
ALTER TABLE "geofence_violation_episodes" ADD CONSTRAINT "geofence_violation_episodes_geofence_id_fkey" FOREIGN KEY ("geofence_id") REFERENCES "geofences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add config columns to geofences
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "speed_min_pings" INTEGER;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "speed_min_duration_sec" INTEGER;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "speed_hysteresis_kmh" DOUBLE PRECISION;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "speed_end_pings" INTEGER;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "speed_renotify_min" INTEGER;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "speed_severity_config" JSONB;

-- Backfill note: existing per-ping SPEED_VIOLATION rows in "alerts" are NOT deleted.
-- They remain queryable as legacy data.
