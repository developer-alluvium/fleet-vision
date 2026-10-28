import { redis } from "@fleet-vision/db";

// ─── Downsampling Engine Configuration ───────────────────────

export const DOWNSAMPLING_CONFIG = {
  // Master toggle (can disable via DOWNSAMPLING_ENABLED=false)
  ENABLED: process.env.DOWNSAMPLING_ENABLED !== "false",

  // Golden Triangle Platform Thresholds
  DEFAULT_MIN_TIME_SEC: parseInt(process.env.DOWNSAMPLE_MIN_TIME_SEC || "15", 10),
  DEFAULT_MIN_DISTANCE_M: parseFloat(process.env.DOWNSAMPLE_MIN_DISTANCE_M || "50"),
  DEFAULT_MIN_ANGLE_DEG: parseFloat(process.env.DOWNSAMPLE_MIN_ANGLE_DEG || "30"),
};

// ─── Mathematical Utilities ──────────────────────────────────

/**
 * Calculates Great-Circle distance in meters between two coordinates using the Haversine formula.
 */
export function getDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (lat1 === lat2 && lon1 === lon2) return 0;

  const R = 6371000; // Earth radius in meters
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates the shortest angular delta (0°–180°) between two compass headings.
 */
export function getAngleDelta(angle1: number, angle2: number): number {
  const diff = Math.abs(angle1 - angle2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// ─── State Management ────────────────────────────────────────

export interface LastSavedTelemetryState {
  timestamp: number; // Unix ms
  latitude: number;
  longitude: number;
  angle: number;
  ignition: boolean;
}

// In-memory LRU-like cache for sub-microsecond lookups during high-volume Kafka batches
const lastSavedStateMap = new Map<string, LastSavedTelemetryState>();

// ─── Observability Counters ──────────────────────────────────

let totalEvaluatedCount = 0;
let savedToTimescaleCount = 0;
let skippedDuplicatesCount = 0;

const reasonCounters: Record<string, number> = {
  DISABLED: 0,
  INVALID_COORDINATES: 0,
  FIRST_RECORD: 0,
  IGNITION_CHANGED: 0,
  CRITICAL_EVENT: 0,
  ANGLE_DELTA: 0,
  DISTANCE_DELTA: 0,
  TIME_INTERVAL: 0,
  SKIPPED_REDUNDANT: 0,
};

export function getDownsamplingStats() {
  const total = totalEvaluatedCount;
  const saved = savedToTimescaleCount;
  const skipped = skippedDuplicatesCount;
  const suppressionRate = total > 0 ? ((skipped / total) * 100).toFixed(1) : "0.0";

  return {
    enabled: DOWNSAMPLING_CONFIG.ENABLED,
    totalEvaluated: total,
    savedToTimescale: saved,
    skippedDuplicates: skipped,
    suppressionRatePercent: parseFloat(suppressionRate),
    thresholds: {
      minTimeSec: DOWNSAMPLING_CONFIG.DEFAULT_MIN_TIME_SEC,
      minDistanceM: DOWNSAMPLING_CONFIG.DEFAULT_MIN_DISTANCE_M,
      minAngleDeg: DOWNSAMPLING_CONFIG.DEFAULT_MIN_ANGLE_DEG,
    },
    reasons: { ...reasonCounters },
  };
}

/**
 * Reset observability metrics (e.g. for testing)
 */
export function resetDownsamplingStats() {
  totalEvaluatedCount = 0;
  savedToTimescaleCount = 0;
  skippedDuplicatesCount = 0;
  for (const k of Object.keys(reasonCounters)) {
    reasonCounters[k] = 0;
  }
}

/**
 * Updates the state tracker for a device
 */
export function updateLastSavedState(
  imei: string,
  state: LastSavedTelemetryState
) {
  lastSavedStateMap.set(imei, state);

  // Asynchronously update Redis fallback with 24h TTL (non-blocking)
  redis
    .setex(`downsample:last:${imei}`, 86400, JSON.stringify(state))
    .catch((err) => {
      // Non-fatal warning
    });
}

/**
 * Clears cached state (e.g., when a vehicle is deleted or detached)
 */
export function clearDeviceState(imei: string) {
  lastSavedStateMap.delete(imei);
  redis.del(`downsample:last:${imei}`).catch(() => {});
}

// ─── The Decision Engine (Golden Triangle) ───────────────────

export interface TelemetryDecisionInput {
  timestamp: Date | string;
  latitude: number | null;
  longitude: number | null;
  angle: number | null;
  speed: number | null;
  ignition: boolean;
  eventId?: number;
}

export interface DownsamplingDecision {
  shouldSave: boolean;
  reason:
    | "DISABLED"
    | "INVALID_COORDINATES"
    | "FIRST_RECORD"
    | "IGNITION_CHANGED"
    | "CRITICAL_EVENT"
    | "ANGLE_DELTA"
    | "DISTANCE_DELTA"
    | "TIME_INTERVAL"
    | "SKIPPED_REDUNDANT";
}

/**
 * Determines whether an incoming telemetry record should be written to TimescaleDB disk.
 *
 * The Hot Path (Redis Live Map + SSE) ALWAYS processes every single packet.
 * Only the Cold Path (TimescaleDB disk insertion) is filtered by this function.
 */
export function shouldSaveToTimescale(
  imei: string,
  record: TelemetryDecisionInput,
  overrides?: {
    minTimeSec?: number;
    minDistanceM?: number;
    minAngleDeg?: number;
  }
): DownsamplingDecision {
  totalEvaluatedCount++;

  // 1. If feature toggle is disabled, save everything
  if (!DOWNSAMPLING_CONFIG.ENABLED) {
    savedToTimescaleCount++;
    reasonCounters.DISABLED++;
    return { shouldSave: true, reason: "DISABLED" };
  }

  // 2. Rule 0: Always save if GPS coordinates are null (corrupt/no satellite lock)
  if (record.latitude === null || record.longitude === null) {
    savedToTimescaleCount++;
    reasonCounters.INVALID_COORDINATES++;
    return { shouldSave: true, reason: "INVALID_COORDINATES" };
  }

  const currentTs =
    record.timestamp instanceof Date
      ? record.timestamp.getTime()
      : new Date(record.timestamp).getTime();

  const lastState = lastSavedStateMap.get(imei);

  // 3. Rule 1: Always save the first record seen for a device
  if (!lastState) {
    const newState: LastSavedTelemetryState = {
      timestamp: currentTs,
      latitude: record.latitude,
      longitude: record.longitude,
      angle: record.angle || 0,
      ignition: record.ignition,
    };
    updateLastSavedState(imei, newState);
    savedToTimescaleCount++;
    reasonCounters.FIRST_RECORD++;
    return { shouldSave: true, reason: "FIRST_RECORD" };
  }

  // 4. Rule 2: Always save Ignition state changes (Trip Start / Trip End)
  if (record.ignition !== lastState.ignition) {
    updateLastSavedState(imei, {
      timestamp: currentTs,
      latitude: record.latitude,
      longitude: record.longitude,
      angle: record.angle || 0,
      ignition: record.ignition,
    });
    savedToTimescaleCount++;
    reasonCounters.IGNITION_CHANGED++;
    return { shouldSave: true, reason: "IGNITION_CHANGED" };
  }

  // 5. Rule 3: Always save Critical Events (SOS panic, Tampering, Crash)
  if (record.eventId && record.eventId > 0) {
    updateLastSavedState(imei, {
      timestamp: currentTs,
      latitude: record.latitude,
      longitude: record.longitude,
      angle: record.angle || 0,
      ignition: record.ignition,
    });
    savedToTimescaleCount++;
    reasonCounters.CRITICAL_EVENT++;
    return { shouldSave: true, reason: "CRITICAL_EVENT" };
  }

  // 6. Rule 4: The Golden Triangle Geometric & Time Filter
  const minTimeSec = overrides?.minTimeSec ?? DOWNSAMPLING_CONFIG.DEFAULT_MIN_TIME_SEC;
  const minDistanceM = overrides?.minDistanceM ?? DOWNSAMPLING_CONFIG.DEFAULT_MIN_DISTANCE_M;
  const minAngleDeg = overrides?.minAngleDeg ?? DOWNSAMPLING_CONFIG.DEFAULT_MIN_ANGLE_DEG;

  const timeDiffSec = (currentTs - lastState.timestamp) / 1000;

  // Handle out-of-order packets if timestamp is older than last saved state
  if (timeDiffSec < 0) {
    // If older by more than 1 hour, save as historical catchup; otherwise skip
    if (Math.abs(timeDiffSec) > 3600) {
      savedToTimescaleCount++;
      return { shouldSave: true, reason: "TIME_INTERVAL" };
    }
    skippedDuplicatesCount++;
    reasonCounters.SKIPPED_REDUNDANT++;
    return { shouldSave: false, reason: "SKIPPED_REDUNDANT" };
  }

  // Check 4A: Angle Delta Trigger (Turns, Roundabouts, Curved ramps)
  const angleDelta = getAngleDelta(lastState.angle, record.angle || 0);
  if (angleDelta >= minAngleDeg) {
    updateLastSavedState(imei, {
      timestamp: currentTs,
      latitude: record.latitude,
      longitude: record.longitude,
      angle: record.angle || 0,
      ignition: record.ignition,
    });
    savedToTimescaleCount++;
    reasonCounters.ANGLE_DELTA++;
    return { shouldSave: true, reason: "ANGLE_DELTA" };
  }

  // Check 4B: Distance Delta Trigger (Highway advancement)
  const distanceMovedMeters = getDistanceMeters(
    lastState.latitude,
    lastState.longitude,
    record.latitude,
    record.longitude
  );

  if (distanceMovedMeters >= minDistanceM) {
    updateLastSavedState(imei, {
      timestamp: currentTs,
      latitude: record.latitude,
      longitude: record.longitude,
      angle: record.angle || 0,
      ignition: record.ignition,
    });
    savedToTimescaleCount++;
    reasonCounters.DISTANCE_DELTA++;
    return { shouldSave: true, reason: "DISTANCE_DELTA" };
  }

  // Check 4C: Periodic Time Trigger (Heavy traffic, stops, crawling)
  if (timeDiffSec >= minTimeSec) {
    updateLastSavedState(imei, {
      timestamp: currentTs,
      latitude: record.latitude,
      longitude: record.longitude,
      angle: record.angle || 0,
      ignition: record.ignition,
    });
    savedToTimescaleCount++;
    reasonCounters.TIME_INTERVAL++;
    return { shouldSave: true, reason: "TIME_INTERVAL" };
  }

  // 7. None of the Golden Triangle conditions met → Skip saving to TimescaleDB
  // The record was already forwarded to Redis Live Map & SSE Hot Path!
  skippedDuplicatesCount++;
  reasonCounters.SKIPPED_REDUNDANT++;
  return { shouldSave: false, reason: "SKIPPED_REDUNDANT" };
}
