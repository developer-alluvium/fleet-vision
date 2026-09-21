import { getDistance, Point } from './douglasPeucker';

// ─── Types ───────────────────────────────────────────────────

export interface TelemetryRow {
  time: Date;
  lat: number;
  lng: number;
  speed: number;
  ignition: boolean;
  fuelLevelRaw: number | null;
  fuelLevelLiters: number | null;
  odometer: number | null;
}

export interface UtilizationTimeBucket {
  bucket: string;               // ISO 8601 start of the bucket
  distanceKm: number;
  drivingMinutes: number;
  idleMinutes: number;
  stoppedMinutes: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  telemetryPoints: number;
}

export interface VehicleUtilizationSummary {
  totalDistanceKm: number;
  drivingMinutes: number;
  idleMinutes: number;
  stoppedMinutes: number;
  utilizationPercent: number;   // driving / total period × 100
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  telemetryPoints: number;
  startOdometer: number | null;
  endOdometer: number | null;
  fuelStartLiters: number | null;
  fuelEndLiters: number | null;
  fuelConsumedLiters: number | null;
}

export interface VehicleUtilization {
  vehicleId: string;
  plateNumber: string;
  imei: string;
  make: string | null;
  model: string | null;
  summary: VehicleUtilizationSummary;
  timeSeries: UtilizationTimeBucket[];
}

export interface FleetSummary {
  totalVehicles: number;
  vehiclesWithData: number;
  totalDistanceKm: number;
  totalDrivingMinutes: number;
  totalIdleMinutes: number;
  totalStoppedMinutes: number;
  avgUtilizationPercent: number;
  avgDailyDistanceKm: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  fuelConsumedLiters: number | null;
}

export type GroupBy = 'hour' | 'day' | 'week';

// ─── Constants ───────────────────────────────────────────────

/** Speed threshold in km/h — above this = driving, at or below = idle/stopped */
const DRIVING_SPEED_THRESHOLD = 2;

/** Ignore gaps larger than this (device offline periods) */
const MAX_GAP_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── Bucket Helpers ──────────────────────────────────────────

/**
 * Returns the bucket key (ISO string of the bucket start) for a given timestamp.
 */
function getBucketKey(time: Date, groupBy: GroupBy): string {
  const d = new Date(time);
  switch (groupBy) {
    case 'hour':
      d.setMinutes(0, 0, 0);
      return d.toISOString();
    case 'day':
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    case 'week': {
      // ISO week: Monday as first day
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      d.setDate(diff);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
  }
}

function createEmptyBucket(bucketKey: string): UtilizationTimeBucket {
  return {
    bucket: bucketKey,
    distanceKm: 0,
    drivingMinutes: 0,
    idleMinutes: 0,
    stoppedMinutes: 0,
    maxSpeedKmh: 0,
    avgSpeedKmh: 0,
    telemetryPoints: 0,
  };
}

// ─── Core Computation ────────────────────────────────────────

/**
 * Computes utilization metrics for a single vehicle's telemetry records.
 *
 * Uses the same driving/idle/stopped classification as journeySummary.ts:
 *   - speed > 2 km/h → driving
 *   - ignition ON + speed ≤ 2 → idle
 *   - else → stopped
 *
 * @param records  Chronologically-sorted telemetry rows for one vehicle.
 * @param groupBy  Time bucketing granularity.
 * @param periodStartMs  Start of the query period (ms).
 * @param periodEndMs    End of the query period (ms).
 */
export function computeVehicleUtilization(
  records: TelemetryRow[],
  groupBy: GroupBy,
  periodStartMs: number,
  periodEndMs: number,
): { summary: VehicleUtilizationSummary; timeSeries: UtilizationTimeBucket[] } {
  const totalPeriodMinutes = (periodEndMs - periodStartMs) / 60_000;

  if (records.length === 0) {
    return {
      summary: emptySummary(0),
      timeSeries: [],
    };
  }

  // ── Accumulate per-bucket ──────────────────────────────────

  const buckets = new Map<string, UtilizationTimeBucket>();
  // Per-bucket speed accumulators for weighted average
  const bucketSpeedAccum = new Map<string, { sum: number; count: number }>();

  let totalDistanceM = 0;
  let totalDrivingMs = 0;
  let totalIdleMs = 0;
  let totalStoppedMs = 0;
  let maxSpeed = 0;
  let speedSum = 0;
  let speedCount = 0;

  // Ensure first point's bucket exists and count it
  const firstBucketKey = getBucketKey(records[0].time, groupBy);
  if (!buckets.has(firstBucketKey)) {
    buckets.set(firstBucketKey, createEmptyBucket(firstBucketKey));
    bucketSpeedAccum.set(firstBucketKey, { sum: 0, count: 0 });
  }
  buckets.get(firstBucketKey)!.telemetryPoints++;

  if ((records[0].speed || 0) > maxSpeed) {
    maxSpeed = records[0].speed || 0;
  }

  let prevRecord = records[0];

  for (let i = 1; i < records.length; i++) {
    const curr = records[i];
    const bucketKey = getBucketKey(curr.time, groupBy);

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, createEmptyBucket(bucketKey));
      bucketSpeedAccum.set(bucketKey, { sum: 0, count: 0 });
    }

    const bucket = buckets.get(bucketKey)!;
    bucket.telemetryPoints++;

    // Distance (Haversine)
    const prevPoint: Point = { lat: prevRecord.lat, lng: prevRecord.lng };
    const currPoint: Point = { lat: curr.lat, lng: curr.lng };
    const distM = getDistance(prevPoint, currPoint);
    totalDistanceM += distM;
    bucket.distanceKm += distM / 1000;

    // Time gap
    const timeDiffMs = curr.time.getTime() - prevRecord.time.getTime();

    if (timeDiffMs > 0 && timeDiffMs < MAX_GAP_MS) {
      const avgSegmentSpeed = ((prevRecord.speed || 0) + (curr.speed || 0)) / 2;
      const isDriving = avgSegmentSpeed > DRIVING_SPEED_THRESHOLD;
      const isIdle = !isDriving && prevRecord.ignition;

      if (isDriving) {
        totalDrivingMs += timeDiffMs;
        bucket.drivingMinutes += timeDiffMs / 60_000;
      } else if (isIdle) {
        totalIdleMs += timeDiffMs;
        bucket.idleMinutes += timeDiffMs / 60_000;
      } else {
        totalStoppedMs += timeDiffMs;
        bucket.stoppedMinutes += timeDiffMs / 60_000;
      }
    }

    // Speed tracking
    const currSpeed = curr.speed || 0;
    if (currSpeed > maxSpeed) maxSpeed = currSpeed;
    if (currSpeed > bucket.maxSpeedKmh) bucket.maxSpeedKmh = currSpeed;

    if (currSpeed > 0) {
      speedSum += currSpeed;
      speedCount++;

      const bsa = bucketSpeedAccum.get(bucketKey)!;
      bsa.sum += currSpeed;
      bsa.count++;
    }

    prevRecord = curr;
  }

  // ── Finalize buckets ───────────────────────────────────────

  const timeSeries: UtilizationTimeBucket[] = [];
  for (const [key, bucket] of buckets) {
    // Round duration fields
    bucket.distanceKm = Number(bucket.distanceKm.toFixed(2));
    bucket.drivingMinutes = Math.round(bucket.drivingMinutes);
    bucket.idleMinutes = Math.round(bucket.idleMinutes);
    bucket.stoppedMinutes = Math.round(bucket.stoppedMinutes);
    bucket.maxSpeedKmh = Math.round(bucket.maxSpeedKmh);

    const bsa = bucketSpeedAccum.get(key)!;
    bucket.avgSpeedKmh = bsa.count > 0 ? Number((bsa.sum / bsa.count).toFixed(1)) : 0;

    timeSeries.push(bucket);
  }

  // Sort buckets chronologically
  timeSeries.sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime());

  // ── Fuel delta ─────────────────────────────────────────────

  const firstFuel = records[0].fuelLevelLiters;
  const lastFuel = records[records.length - 1].fuelLevelLiters;
  let fuelConsumed: number | null = null;
  if (firstFuel != null && lastFuel != null) {
    fuelConsumed = Number((firstFuel - lastFuel).toFixed(2));
  }

  // ── Build summary ──────────────────────────────────────────

  const drivingMinutes = Math.round(totalDrivingMs / 60_000);
  const utilizationPercent = totalPeriodMinutes > 0
    ? Number(((drivingMinutes / totalPeriodMinutes) * 100).toFixed(1))
    : 0;

  const summary: VehicleUtilizationSummary = {
    totalDistanceKm: Number((totalDistanceM / 1000).toFixed(2)),
    drivingMinutes,
    idleMinutes: Math.round(totalIdleMs / 60_000),
    stoppedMinutes: Math.round(totalStoppedMs / 60_000),
    utilizationPercent,
    maxSpeedKmh: Math.round(maxSpeed),
    avgSpeedKmh: speedCount > 0 ? Number((speedSum / speedCount).toFixed(1)) : 0,
    telemetryPoints: records.length,
    startOdometer: records[0].odometer ?? null,
    endOdometer: records[records.length - 1].odometer ?? null,
    fuelStartLiters: firstFuel ?? null,
    fuelEndLiters: lastFuel ?? null,
    fuelConsumedLiters: fuelConsumed,
  };

  return { summary, timeSeries };
}

// ─── Fleet Aggregation ───────────────────────────────────────

/**
 * Rolls up per-vehicle utilization summaries into a fleet-wide summary.
 */
export function aggregateFleetSummary(
  vehicles: VehicleUtilization[],
  totalVehicles: number,
  periodDays: number,
): FleetSummary {
  const withData = vehicles.filter(v => v.summary.telemetryPoints > 0);

  let totalDistanceKm = 0;
  let totalDrivingMinutes = 0;
  let totalIdleMinutes = 0;
  let totalStoppedMinutes = 0;
  let maxSpeedKmh = 0;
  let speedSum = 0;
  let speedCount = 0;
  let fuelConsumedTotal = 0;
  let hasFuelData = false;
  let utilizationSum = 0;

  for (const v of withData) {
    const s = v.summary;
    totalDistanceKm += s.totalDistanceKm;
    totalDrivingMinutes += s.drivingMinutes;
    totalIdleMinutes += s.idleMinutes;
    totalStoppedMinutes += s.stoppedMinutes;
    utilizationSum += s.utilizationPercent;

    if (s.maxSpeedKmh > maxSpeedKmh) maxSpeedKmh = s.maxSpeedKmh;
    if (s.avgSpeedKmh > 0) {
      speedSum += s.avgSpeedKmh;
      speedCount++;
    }
    if (s.fuelConsumedLiters != null) {
      fuelConsumedTotal += s.fuelConsumedLiters;
      hasFuelData = true;
    }
  }

  const effectiveDays = Math.max(periodDays, 1);

  return {
    totalVehicles,
    vehiclesWithData: withData.length,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    totalDrivingMinutes,
    totalIdleMinutes,
    totalStoppedMinutes,
    avgUtilizationPercent: withData.length > 0
      ? Number((utilizationSum / withData.length).toFixed(1))
      : 0,
    avgDailyDistanceKm: Number((totalDistanceKm / effectiveDays).toFixed(2)),
    maxSpeedKmh,
    avgSpeedKmh: speedCount > 0 ? Number((speedSum / speedCount).toFixed(1)) : 0,
    fuelConsumedLiters: hasFuelData ? Number(fuelConsumedTotal.toFixed(2)) : null,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function emptySummary(utilizationPercent: number): VehicleUtilizationSummary {
  return {
    totalDistanceKm: 0,
    drivingMinutes: 0,
    idleMinutes: 0,
    stoppedMinutes: 0,
    utilizationPercent,
    maxSpeedKmh: 0,
    avgSpeedKmh: 0,
    telemetryPoints: 0,
    startOdometer: null,
    endOdometer: null,
    fuelStartLiters: null,
    fuelEndLiters: null,
    fuelConsumedLiters: null,
  };
}
