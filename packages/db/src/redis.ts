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
