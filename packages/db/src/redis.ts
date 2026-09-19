import Redis from "ioredis";

// ─── Redis Client Singleton ──────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

export const redis =
  globalForRedis.redis ??
  new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

// ─── Auth Cache Helpers ──────────────────────────────────────

/**
 * Authorizes a device by caching its IMEI→orgId mapping in Redis.
 * Called when a device is provisioned via the Control Plane API.
 */
export async function authorizeDevice(
  imei: string,
  orgId: string
): Promise<void> {
  await redis.hset(`auth:${imei}`, {
    isAuthorized: "true",
    orgId,
  });
}

/**
 * Revokes device authorization by removing its Redis cache entry.
 */
export async function revokeDevice(imei: string): Promise<void> {
  await redis.del(`auth:${imei}`);
}

/**
 * Looks up a device's authorization status and orgId from Redis.
 * Returns null if the device is not authorized.
 */
export async function getDeviceAuth(
  imei: string
): Promise<{ isAuthorized: boolean; orgId: string } | null> {
  const data = await redis.hgetall(`auth:${imei}`);
  if (!data || !data.isAuthorized || data.isAuthorized !== "true") {
    return null;
  }
  return { isAuthorized: true, orgId: data.orgId };
}

// ─── Live Map Helpers ────────────────────────────────────────

/**
 * Updates the live location for a device in the org's live map hash.
 */
export async function updateLiveMap(
  orgId: string,
  imei: string,
  payload: object
): Promise<void> {
  await redis.hset(`live_map:org:${orgId}`, imei, JSON.stringify(payload));
}

/**
 * Gets all live device locations for an organization.
 */
export async function getLiveMap(
  orgId: string
): Promise<Record<string, object>> {
  const raw = await redis.hgetall(`live_map:org:${orgId}`);
  const result: Record<string, object> = {};
  for (const [imei, json] of Object.entries(raw)) {
    try {
      result[imei] = JSON.parse(json);
    } catch {
      result[imei] = { raw: json };
    }
  }
  return result;
}

/**
 * Gets live locations for a specific batch of devices using a Redis pipeline.
 */
export async function getLiveLocationsByImeis(
  orgId: string,
  imeis: string[]
): Promise<Record<string, object | null>> {
  if (imeis.length === 0) return {};

  const pipeline = redis.pipeline();
  for (const imei of imeis) {
    pipeline.hget(`live_map:org:${orgId}`, imei);
  }

  const results = await pipeline.exec();
  const map: Record<string, object | null> = {};

  imeis.forEach((imei, idx) => {
    // Pipeline exec returns [error, result] for each command
    const [err, raw] = results![idx];
    if (!err && raw) {
      try {
        map[imei] = JSON.parse(raw as string);
      } catch {
        map[imei] = null;
      }
    } else {
      map[imei] = null;
    }
  });

  return map;
}

/**
 * Publishes a location update to Redis Pub/Sub channels.
 * Channel 1: location:org:{orgId}   → consumed by fleet stream SSE
 * Channel 2: location:device:{imei} → consumed by single-device live location
 * NOTE: This publishes only the LATEST record per batch (for fleet map / live marker).
 */
export async function publishLocationUpdate(
  orgId: string,
  imei: string,
  payload: object
): Promise<void> {
  const message = JSON.stringify({ orgId, imei, ...payload });
  await Promise.all([
    redis.publish(`location:org:${orgId}`, message),
    redis.publish(`location:device:${imei}`, message),
  ]);
}

// ─── Journey Stream Helpers ──────────────────────────────────

/**
 * Publishes each individual telemetry record to the journey Pub/Sub channel.
 * Uses Redis pipeline to batch all PUBLISH commands into a single round-trip
 * (O(1) network cost regardless of record count).
 *
 * Channel: journey:device:{imei} → consumed by journey stream SSE
 *
 * Unlike publishLocationUpdate (which sends only the latest record per batch),
 * this function publishes EVERY record so that the journey SSE stream can
 * render the full vehicle path in real-time.
 */
export async function publishJourneyRecords(
  orgId: string,
  imei: string,
  records: Array<{
    latitude: number | null;
    longitude: number | null;
    speed: number | null;
    ignition: boolean;
    odometer?: number | null;
    timestamp: string;
  }>
): Promise<void> {
  if (records.length === 0) return;

  const pipeline = redis.pipeline();
  for (const record of records) {
    const message = JSON.stringify({
      orgId,
      imei,
      latitude: record.latitude,
      longitude: record.longitude,
      speed: record.speed,
      ignition: record.ignition,
      odometer: record.odometer,
      timestamp: record.timestamp,
      publishedAt: new Date().toISOString(),
    });
    pipeline.publish(`journey:device:${imei}`, message);
  }
  await pipeline.exec();
}

// ─── Fuel Settings Cache Helpers ──────────────────────────

export async function cacheVehicleFuelSettings(
  imei: string,
  settings: { bleFuelChannel: number | null }
): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.hset(`fuel_settings:${imei}`, {
    bleFuelChannel: settings.bleFuelChannel ?? "",
  });
  pipeline.expire(`fuel_settings:${imei}`, 3600); // 1-hour TTL
  await pipeline.exec();
}

export async function getCachedFuelSettings(
  imei: string
): Promise<{ bleFuelChannel: number | null } | null> {
  const data = await redis.hgetall(`fuel_settings:${imei}`);
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  
  return {
    bleFuelChannel: data.bleFuelChannel ? parseInt(data.bleFuelChannel, 10) : null,
  };
}

export async function invalidateFuelSettingsCache(imei: string): Promise<void> {
  await redis.del(`fuel_settings:${imei}`);
}

// ─── Fuel Calibration Table Cache ─────────────────────────

import type { CalibrationPoint } from "./fuelCalibration";

export async function cacheCalibrationTable(imei: string, points: CalibrationPoint[]): Promise<void> {
  await redis.setex(`fuel_cal:${imei}`, 3600, JSON.stringify(points));
}

export async function getCachedCalibrationTable(imei: string): Promise<CalibrationPoint[] | null> {
  const data = await redis.get(`fuel_cal:${imei}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as CalibrationPoint[];
  } catch {
    return null;
  }
}

export async function invalidateCalibrationCache(imei: string): Promise<void> {
  await redis.del(`fuel_cal:${imei}`);
}

// ─── Fleet Status Helpers ────────────────────────────────────

export type DeviceStatus = 'RUNNING' | 'IDLE' | 'STOPPED' | 'INACTIVE' | 'NO_DATA';

/**
 * Computes the status of a single device based on its live map payload.
 * Pure function — no I/O.
 */
export function computeDeviceStatus(
  payload: { ignition?: boolean; speed?: number; timestamp?: string; updatedAt?: string } | null,
  nowMs: number,
  staleThresholdMs: number = 5 * 60 * 1000,   // default: 5 minutes
  inactiveThresholdMs: number = 24 * 60 * 60 * 1000 // default: 24 hours
): DeviceStatus {
  if (!payload || !payload.timestamp) {
    return 'NO_DATA';
  }

  const lastSeenMs = new Date(payload.timestamp).getTime();
  const ageMs = nowMs - lastSeenMs;

  if (ageMs >= inactiveThresholdMs) {
    return 'INACTIVE';
  }

  if (payload.ignition) {
    if (ageMs < staleThresholdMs) {
      if (payload.speed && payload.speed > 0) {
        return 'RUNNING';
      }
      return 'IDLE';
    }
    // If ignition is on but data is stale, it's stopped/offline.
    return 'STOPPED';
  }

  return 'STOPPED';
}

/**
 * Stores per-device status in Redis hash and a summary count hash.
 */
export async function updateFleetStatus(
  orgId: string,
  statusMap: Record<string, string>,
  summary: Record<string, number>
): Promise<void> {
  const pipeline = redis.pipeline();
  
  if (Object.keys(statusMap).length > 0) {
    pipeline.hset(`fleet_status:org:${orgId}`, statusMap);
  }
  
  if (Object.keys(summary).length > 0) {
    // Clear old summary first to prevent stale keys if a status drops to 0
    pipeline.del(`fleet_status_summary:org:${orgId}`);
    pipeline.hset(`fleet_status_summary:org:${orgId}`, summary);
  }

  pipeline.set(`fleet_status_ts:org:${orgId}`, new Date().toISOString());
  
  await pipeline.exec();
}

/**
 * Returns the pre-computed fleet status summary from Redis.
 */
export async function getFleetStatusSummary(
  orgId: string
): Promise<{ summary: Record<string, number>; computedAt: string | null }> {
  const [summaryRaw, computedAt] = await Promise.all([
    redis.hgetall(`fleet_status_summary:org:${orgId}`),
    redis.get(`fleet_status_ts:org:${orgId}`)
  ]);

  const summary: Record<string, number> = {};
  for (const [key, val] of Object.entries(summaryRaw)) {
    summary[key] = parseInt(val, 10) || 0;
  }

  return { summary, computedAt };
}

/**
 * Returns per-device status breakdown from Redis.
 */
export async function getFleetStatusDetails(
  orgId: string
): Promise<Record<string, string>> {
  return await redis.hgetall(`fleet_status:org:${orgId}`);
}

/**
 * Publishes status change events to Pub/Sub for real-time SSE streaming.
 */
export async function publishFleetStatusUpdate(
  orgId: string,
  summary: Record<string, number>,
  changedDevices: Array<{ imei: string; previousStatus: string; newStatus: string }>
): Promise<void> {
  const message = JSON.stringify({
    counts: summary,
    changed: changedDevices,
    timestamp: new Date().toISOString()
  });
  await redis.publish(`fleet_status:org:${orgId}`, message);
}

