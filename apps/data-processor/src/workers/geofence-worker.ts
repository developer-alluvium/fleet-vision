import {
  prisma,
  getCachedOrgGeofences,
  cacheOrgGeofences,
  updateDeviceGeofenceState,
  publishGeofenceAlert,
  GeofenceCacheEntry,
} from "@fleet-vision/db";

// Types matching the parsed valid records
type TelemetryPoint = {
  imei: string;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;
  time: Date;
};

/**
 * Batch checks geofences for all organizations that received telemetry in the batch.
 * @param orgIds Set of organization IDs affected
 * @param records All valid telemetry records from the batch
 */
export async function batchCheckGeofencesForOrgs(
  orgIds: Set<string>,
  records: Array<{
    organizationId: string;
    imei: string;
    latitude: number | null;
    longitude: number | null;
    speed: number | null;
    time: Date;
  }>
): Promise<void> {
  // Group records by org
  const recordsByOrg = new Map<string, TelemetryPoint[]>();
  for (const record of records) {
    if (record.latitude == null || record.longitude == null) continue;
    let list = recordsByOrg.get(record.organizationId);
    if (!list) {
      list = [];
      recordsByOrg.set(record.organizationId, list);
    }
    list.push({
      imei: record.imei,
      latitude: record.latitude,
      longitude: record.longitude,
      speed: record.speed,
      time: record.time,
    });
  }

  const promises = Array.from(orgIds).map(async (orgId) => {
    const orgRecords = recordsByOrg.get(orgId);
    if (!orgRecords || orgRecords.length === 0) return;

    // Filter to only the latest point per device
    const latestPerDevice = new Map<string, TelemetryPoint>();
    for (const r of orgRecords) {
      const existing = latestPerDevice.get(r.imei);
      if (!existing || r.time.getTime() > existing.time.getTime()) {
        latestPerDevice.set(r.imei, r);
      }
    }

    await processGeofencesForOrg(orgId, Array.from(latestPerDevice.values()));
  });

  await Promise.all(promises);
}

async function processGeofencesForOrg(orgId: string, latestPoints: TelemetryPoint[]): Promise<void> {
  try {
    // 1. Get cached geofences
    let activeGeofences = await getCachedOrgGeofences(orgId);
    if (!activeGeofences) {
      const dbGeofences = await prisma.geofence.findMany({
        where: { organizationId: orgId, isActive: true },
        select: { id: true, name: true, type: true, alertOnEnter: true, alertOnExit: true, speedLimitKmh: true },
      });
      activeGeofences = dbGeofences;
      await cacheOrgGeofences(orgId, activeGeofences);
    }

    if (activeGeofences.length === 0) {
      return; // No active geofences, skip
    }

    // 2. Perform Batch PostGIS Query via JSONB to safely pass multiple points
    const pointsJson = JSON.stringify(latestPoints.map(p => ({
      imei: p.imei,
      lat: p.latitude,
      lng: p.longitude,
      speed: p.speed,
      timestamp: p.time.toISOString()
    })));

    const queryResult: Array<{ geofence_id: string; imei: string }> = await prisma.$queryRaw`
      SELECT
        g.id AS geofence_id,
        points.imei
      FROM "geofences" g
      CROSS JOIN LATERAL jsonb_to_recordset(${pointsJson}::jsonb) AS points(imei text, lat float, lng float, speed float, timestamp text)
      WHERE g.organization_id = ${orgId}
        AND g.is_active = true
        AND (
          (g.type = 'POLYGON' AND ST_Contains(g.polygon, ST_SetSRID(ST_Point(points.lng, points.lat), 4326)))
          OR
          (g.type = 'CIRCLE' AND ST_DWithin(
            ST_SetSRID(ST_Point(points.lng, points.lat), 4326)::geography,
            ST_SetSRID(ST_Point(g.center_lng, g.center_lat), 4326)::geography,
            g.radius_meters
          ))
        )
    `;

    // 3. Map results: imei -> set of geofenceIds they are INSIDE
    const insideMap = new Map<string, Set<string>>();
    for (const row of queryResult) {
      let set = insideMap.get(row.imei);
      if (!set) {
        set = new Set<string>();
        insideMap.set(row.imei, set);
      }
      set.add(row.geofence_id);
    }

    const fenceDict = Object.fromEntries(activeGeofences.map(f => [f.id, f]));

    // 4. Update state machine and generate alerts
    const alertsToCreate: any[] = [];
    
    for (const point of latestPoints) {
      const insideSet = insideMap.get(point.imei) || new Set<string>();
      
      const newState: Record<string, boolean> = {};
      for (const fence of activeGeofences) {
        newState[fence.id] = insideSet.has(fence.id);
      }

      // Diff state using Redis helper
      const transitions = await updateDeviceGeofenceState(orgId, point.imei, newState);
      
      for (const transition of transitions) {
        const fence = fenceDict[transition.geofenceId];
        if (!fence) continue;

        if ((transition.eventType === "ENTER" && fence.alertOnEnter) || 
            (transition.eventType === "EXIT" && fence.alertOnExit)) {
          
          const alert = {
            geofenceId: fence.id,
            organizationId: orgId,
            imei: point.imei,
            eventType: transition.eventType,
            latitude: point.latitude!,
            longitude: point.longitude!,
            speed: point.speed,
            timestamp: point.time,
          };
          
          alertsToCreate.push(alert);
          
          // Publish real-time SSE
          await publishGeofenceAlert(orgId, {
            ...alert,
            geofenceName: fence.name,
            timestamp: alert.timestamp.toISOString(),
          });
        }
      }

      // Handle Speed Violations (if inside and exceeding limit)
      for (const fenceId of insideSet) {
        const fence = fenceDict[fenceId];
        if (fence && fence.speedLimitKmh && point.speed != null && point.speed > fence.speedLimitKmh) {
          const alert = {
            geofenceId: fence.id,
            organizationId: orgId,
            imei: point.imei,
            eventType: "SPEED_VIOLATION",
            latitude: point.latitude!,
            longitude: point.longitude!,
            speed: point.speed,
            timestamp: point.time,
          };
          
          alertsToCreate.push(alert);
          
          await publishGeofenceAlert(orgId, {
            ...alert,
            geofenceName: fence.name,
            speedLimit: fence.speedLimitKmh,
            timestamp: alert.timestamp.toISOString(),
          });
        }
      }
    }

    // 5. Bulk insert alerts
    if (alertsToCreate.length > 0) {
      await prisma.geofenceAlert.createMany({
        data: alertsToCreate
      });
      console.log(`[GEOFENCE] Created ${alertsToCreate.length} alerts for org ${orgId}`);
    }
  } catch (err) {
    console.error(`[GEOFENCE] Error processing geofences for org ${orgId}:`, err);
  }
}
