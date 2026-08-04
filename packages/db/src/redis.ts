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
 * Channel 2: location:device:{imei} → consumed by journey stream SSE
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
