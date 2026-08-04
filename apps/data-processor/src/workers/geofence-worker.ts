import { prisma } from "@fleet-vision/db";

/**
 * Geofence Worker
 *
 * After telemetry records are saved, checks if any new (latitude, longitude)
 * coordinates intersect with geofence polygons for the given organization.
 *
 * Uses raw PostGIS SQL for high-performance spatial queries.
 */

interface GeofenceAlert {
  geofenceId: string;
  geofenceName: string;
  imei: string;
  orgId: string;
  latitude: number;
  longitude: number;
  timestamp: Date;
}

/**
 * Checks if a telemetry point falls within any geofence for the given org.
 * Returns an array of triggered geofence alerts.
 */
export async function checkGeofences(
  orgId: string,
  imei: string,
  latitude: number,
  longitude: number
): Promise<GeofenceAlert[]> {
  if (!latitude || !longitude) return [];

  try {
    // Raw PostGIS query: find all geofences that contain this point
    const results: Array<{ id: string; name: string }> =
      await prisma.$queryRawUnsafe(
        `
        SELECT id, name
        FROM "geofences"
        WHERE "organization_id" = $1
          AND ST_Contains(
            polygon,
            ST_SetSRID(ST_Point($2, $3), 4326)
          )
        `,
        orgId,
        longitude, // ST_Point takes (x, y) = (lon, lat)
        latitude
      );

    if (results.length === 0) return [];

    const alerts: GeofenceAlert[] = results.map((gf) => ({
      geofenceId: gf.id,
      geofenceName: gf.name,
      imei,
      orgId,
      latitude,
      longitude,
      timestamp: new Date(),
    }));

    for (const alert of alerts) {
      console.log(
        `[GEOFENCE] ⚠ ALERT: Device ${alert.imei} entered geofence "${alert.geofenceName}" ` +
          `(org: ${alert.orgId}, lat: ${alert.latitude}, lon: ${alert.longitude})`
      );
    }

    return alerts;
  } catch (err) {
    console.error(
      `[GEOFENCE] Error checking geofences for IMEI ${imei}:`,
      err
    );
    return [];
  }
}

/**
 * Batch check geofences for multiple telemetry points.
 * Call this after processTelemetryBatch completes.
 */
export async function batchCheckGeofences(
  records: Array<{
    orgId: string;
    imei: string;
    latitude: number | null;
    longitude: number | null;
  }>
): Promise<GeofenceAlert[]> {
  const allAlerts: GeofenceAlert[] = [];

  for (const record of records) {
    if (record.latitude == null || record.longitude == null) continue;

    const alerts = await checkGeofences(
      record.orgId,
      record.imei,
      record.latitude,
      record.longitude
    );
    allAlerts.push(...alerts);
  }

  return allAlerts;
}
