import {
  prisma,
  getCachedOrgGeofences,
  cacheOrgGeofences,
  updateDeviceGeofenceState,
  publishGeofenceAlert,
  GeofenceCacheEntry,
  getGeofenceSpeedEpisodeState,
  setGeofenceSpeedEpisodeState,
  deleteGeofenceSpeedEpisodeState,
} from "@fleet-vision/db";
import { processSpeedPing, SpeedEpisodeConfig } from "./speed-episode-engine";

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
        select: { 
          id: true, name: true, type: true, alertOnEnter: true, alertOnExit: true, speedLimitKmh: true,
          speedMinPings: true, speedMinDurationSec: true, speedHysteresisKmh: true, speedEndPings: true,
          speedRenotifyMin: true, speedSeverityConfig: true
        },
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

        if (transition.eventType === "EXIT" && fence.speedLimitKmh) {
          // Attempt to close open episode on exit
          const episodeState = await getGeofenceSpeedEpisodeState(point.imei, fence.id);
          if (episodeState && episodeState.status === "SPEEDING" && episodeState.episodeId) {
            const durationSec = episodeState.episodeStartTs
              ? (point.time.getTime() - new Date(episodeState.episodeStartTs).getTime()) / 1000
              : 0;
            const avgSpeed = episodeState.pingCount > 0 ? episodeState.speedSum / episodeState.pingCount : 0;
            
            await prisma.geofenceViolationEpisode.updateMany({
              where: { id: episodeState.episodeId },
              data: {
                status: "CLOSED",
                endedAt: point.time,
                durationSec: Math.round(durationSec),
                peakSpeedKmh: episodeState.peakSpeed,
                avgSpeedKmh: avgSpeed,
                closeReason: "EXIT"
              }
            });
            await deleteGeofenceSpeedEpisodeState(point.imei, fence.id);
          } else if (episodeState) {
            await deleteGeofenceSpeedEpisodeState(point.imei, fence.id);
          }
        }

        if ((transition.eventType === "ENTER" && fence.alertOnEnter) || 
            (transition.eventType === "EXIT" && fence.alertOnExit)) {
          
          const alert = {
            category: "GEOFENCE",
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
          } as any);
        }
      }

      // Handle Speed Violations via Episode Engine
      for (const fenceId of insideSet) {
        const fence = fenceDict[fenceId];
        if (fence && fence.speedLimitKmh && point.speed != null) {
          const config: SpeedEpisodeConfig = {
            speedLimitKmh: fence.speedLimitKmh,
            minPings: fence.speedMinPings ?? 2,
            minDurationSec: fence.speedMinDurationSec ?? 10,
            hysteresisKmh: fence.speedHysteresisKmh ?? 3,
            endPings: fence.speedEndPings ?? 2,
            renotifyIntervalMin: fence.speedRenotifyMin ?? 5,
            severityThresholds: fence.speedSeverityConfig ? (fence.speedSeverityConfig as any) : { minor: 1.2, major: 1.5 },
          };

          const currentState = await getGeofenceSpeedEpisodeState(point.imei, fence.id);
          const { newState, events, suppressNotification } = processSpeedPing(
            currentState, 
            { speed: point.speed, lat: point.latitude!, lng: point.longitude!, timestamp: point.time.toISOString() },
            config
          );

          await setGeofenceSpeedEpisodeState(point.imei, fence.id, newState);

          for (const ev of events) {
            if (ev.type === "ViolationStarted" && !suppressNotification) {
              await prisma.geofenceViolationEpisode.upsert({
                where: {
                   imei_geofenceId_startedAt: {
                     imei: point.imei,
                     geofenceId: fence.id,
                     startedAt: new Date(newState.episodeStartTs!)
                   }
                },
                create: {
                  id: ev.episodeId,
                  organizationId: orgId,
                  imei: point.imei,
                  geofenceId: fence.id,
                  status: "OPEN",
                  startedAt: new Date(newState.episodeStartTs!),
                  limitKmh: config.speedLimitKmh,
                  peakSpeedKmh: newState.peakSpeed,
                  startLat: newState.peakLat,
                  startLng: newState.peakLng,
                  peakLat: newState.peakLat,
                  peakLng: newState.peakLng,
                  severity: newState.severity,
                  pingCount: 1,
                  notifiedCount: 1,
                  lastNotifiedAt: point.time,
                },
                update: {
                  peakSpeedKmh: newState.peakSpeed,
                  severity: newState.severity,
                }
              });

              await publishGeofenceAlert(orgId, {
                imei: point.imei,
                geofenceId: fence.id,
                geofenceName: fence.name,
                eventType: "SPEED_VIOLATION",
                latitude: point.latitude!,
                longitude: point.longitude!,
                speed: point.speed,
                speedLimit: fence.speedLimitKmh,
                timestamp: point.time.toISOString(),
              });

            } else if (ev.type === "ViolationEscalated" && newState.episodeId && !suppressNotification) {
              await prisma.geofenceViolationEpisode.updateMany({
                where: { id: newState.episodeId },
                data: {
                  peakSpeedKmh: newState.peakSpeed,
                  peakLat: newState.peakLat,
                  peakLng: newState.peakLng,
                  severity: newState.severity,
                  pingCount: newState.pingCount,
                  lastNotifiedAt: point.time,
                  notifiedCount: { increment: 1 }
                }
              });
              await publishGeofenceAlert(orgId, {
                imei: point.imei,
                geofenceId: fence.id,
                geofenceName: fence.name,
                eventType: "SPEED_VIOLATION",
                latitude: point.latitude!,
                longitude: point.longitude!,
                speed: point.speed,
                speedLimit: fence.speedLimitKmh,
                timestamp: point.time.toISOString(),
              });
            } else if (ev.type === "ViolationReminder" && newState.episodeId && !suppressNotification) {
              await prisma.geofenceViolationEpisode.updateMany({
                where: { id: newState.episodeId },
                data: {
                  pingCount: newState.pingCount,
                  lastNotifiedAt: point.time,
                  notifiedCount: { increment: 1 }
                }
              });
              await publishGeofenceAlert(orgId, {
                imei: point.imei,
                geofenceId: fence.id,
                geofenceName: fence.name,
                eventType: "SPEED_VIOLATION",
                latitude: point.latitude!,
                longitude: point.longitude!,
                speed: point.speed,
                speedLimit: fence.speedLimitKmh,
                timestamp: point.time.toISOString(),
              });
            } else if (ev.type === "ViolationEnded" && newState.episodeId) {
              await prisma.geofenceViolationEpisode.updateMany({
                where: { id: newState.episodeId },
                data: {
                  status: "CLOSED",
                  endedAt: point.time,
                  durationSec: ev.durationSec,
                  peakSpeedKmh: ev.peakSpeed,
                  avgSpeedKmh: ev.avgSpeed,
                  closeReason: ev.closeReason,
                  pingCount: newState.pingCount,
                }
              });
            }
          }
        }
      }
    }

    // 5. Bulk insert alerts
    if (alertsToCreate.length > 0) {
      await prisma.alert.createMany({
        data: alertsToCreate
      });
      console.log(`[GEOFENCE] Created ${alertsToCreate.length} alerts for org ${orgId}`);
    }
  } catch (err) {
    console.error(`[GEOFENCE] Error processing geofences for org ${orgId}:`, err);
  }
}
