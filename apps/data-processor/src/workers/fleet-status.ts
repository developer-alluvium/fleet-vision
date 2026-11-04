import {
  prisma,
  redis,
  getLiveMap,
  getFleetStatusDetails,
  computeDeviceStatus,
  updateFleetStatus,
  publishFleetStatusUpdate,
  FleetDashboardPayload,
} from "@fleet-vision/db";

// Thresholds from environment variables or defaults
const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MINUTES || "5", 10) * 60 * 1000;
const INACTIVE_THRESHOLD_MS = parseInt(process.env.INACTIVE_THRESHOLD_HOURS || "24", 10) * 60 * 60 * 1000;
const LOW_FUEL_THRESHOLD = parseInt(process.env.LOW_FUEL_THRESHOLD_LITERS || "50", 10);
const CRITICAL_FUEL_THRESHOLD = parseInt(process.env.CRITICAL_FUEL_THRESHOLD_LITERS || "20", 10);

/**
 * Recomputes the fleet status for a given organization and publishes any changes.
 * This is designed to be called efficiently after a telemetry batch, or periodically via cron.
 */
export async function recomputeFleetStatus(orgId: string): Promise<void> {
  const nowMs = Date.now();

  try {
    // 1. Fetch current registered devices with optional vehicle assignment
    const devices = await prisma.device.findMany({
      where: { organizationId: orgId },
      select: {
        imei: true,
        vehicle: {
          select: {
            plateNumber: true,
          },
        },
      },
    });

    if (devices.length === 0) {
      return; // No devices, nothing to do
    }

    // 2. Fetch current live map, previous statuses, and stale tracking set
    const staleKey = `fleet_stale:org:${orgId}`;
    const [liveMap, previousStatusMap, previousStaleArray] = await Promise.all([
      getLiveMap(orgId),
      getFleetStatusDetails(orgId),
      redis.smembers(staleKey),
    ]);
    const previousStaleImeis = new Set(previousStaleArray || []);
    const newlyStaleImeis: string[] = [];
    const recoveredImeis: string[] = [];

    // 3. Compute new status for each device and track metrics
    const newStatusMap: Record<string, string> = {};
    const summary: Record<string, number> = {
      TOTAL: devices.length,
      RUNNING: 0,
      IDLE: 0,
      STOPPED: 0,
      INACTIVE: 0,
      NO_DATA: 0,
    };
    const changedDevices: Array<{ imei: string; vehiclePlate?: string | null; previousStatus: string; newStatus: string }> = [];
    const activityFeed: Array<{ type: string; imei: string; vehiclePlate?: string | null; timestamp: string; [key: string]: any }> = [];

    let fuelSum = 0;
    let fuelCount = 0;
    let lowFuelCount = 0;
    let criticalFuelCount = 0;
    const fuelDist = { critical_0_20: 0, low_20_50: 0, medium_50_100: 0, good_100_200: 0, full_200_plus: 0 };

    let engineOnCount = 0;
    let movingCount = 0;

    let freshDataCount = 0;
    let staleDataCount = 0;
    let noDataCount = 0;
    let oldestAge = -1;
    let oldestImei: string | null = null;

    for (const device of devices) {
      const imei = device.imei;
      const vehiclePlate = device.vehicle?.plateNumber || null;
      const payload = liveMap[imei] as any;
      
      const newStatus = computeDeviceStatus(
        payload || null,
        nowMs,
        STALE_THRESHOLD_MS,
        INACTIVE_THRESHOLD_MS
      );

      newStatusMap[imei] = newStatus;
      summary[newStatus]++;

      const prevStatus = previousStatusMap[imei];
      if (prevStatus !== newStatus) {
        changedDevices.push({
          imei,
          vehiclePlate,
          previousStatus: prevStatus || 'NO_DATA',
          newStatus,
        });
        activityFeed.push({
          type: "STATUS_CHANGE",
          imei,
          vehiclePlate,
          from: prevStatus || 'NO_DATA',
          to: newStatus,
          timestamp: new Date(nowMs).toISOString(),
        });
      }

      // ── Fuel Analytics ──
      if (payload?.fuelLevelLiters != null) {
        fuelSum += payload.fuelLevelLiters;
        fuelCount++;
        
        if (payload.fuelLevelLiters < CRITICAL_FUEL_THRESHOLD) {
          criticalFuelCount++;
          const alertKey = `fuel_alert:crit:${imei}`;
          const isNew = await redis.set(alertKey, "1", "EX", 1800, "NX");
          if (isNew === "OK") {
            activityFeed.push({
              type: "CRITICAL_FUEL",
              imei,
              vehiclePlate,
              fuelLevelLiters: payload.fuelLevelLiters,
              threshold: CRITICAL_FUEL_THRESHOLD,
              timestamp: new Date(nowMs).toISOString(),
            });
          }
        } else if (payload.fuelLevelLiters < LOW_FUEL_THRESHOLD) {
          lowFuelCount++;
          const alertKey = `fuel_alert:low:${imei}`;
          const isNew = await redis.set(alertKey, "1", "EX", 1800, "NX");
          if (isNew === "OK") {
            activityFeed.push({
              type: "LOW_FUEL",
              imei,
              vehiclePlate,
              fuelLevelLiters: payload.fuelLevelLiters,
              threshold: LOW_FUEL_THRESHOLD,
              timestamp: new Date(nowMs).toISOString(),
            });
          }
        }

        const f = payload.fuelLevelLiters;
        if (f < 20) fuelDist.critical_0_20++;
        else if (f < 50) fuelDist.low_20_50++;
        else if (f < 100) fuelDist.medium_50_100++;
        else if (f < 200) fuelDist.good_100_200++;
        else fuelDist.full_200_plus++;
      }

      // ── Utilization ──
      if (payload?.ignition) engineOnCount++;
      if (payload?.speed && payload.speed > 0) movingCount++;

      // ── Device Health ──
      if (payload?.timestamp) {
        const lastSeenMs = new Date(payload.timestamp).getTime();
        const ageMs = nowMs - lastSeenMs;
        
        if (ageMs < STALE_THRESHOLD_MS) {
          freshDataCount++;
          if (previousStaleImeis.has(imei)) {
            recoveredImeis.push(imei);
          }
        } else if (ageMs < INACTIVE_THRESHOLD_MS) {
          staleDataCount++;
          // ONLY push to activityFeed on fresh -> stale transition (not repeatedly on every batch)
          if (!previousStaleImeis.has(imei)) {
            newlyStaleImeis.push(imei);
            activityFeed.push({
              type: "DEVICE_STALE",
              imei,
              vehiclePlate,
              ageMs,
              timestamp: new Date(nowMs).toISOString(),
            });
          }
        }
        
        if (ageMs > oldestAge) { 
          oldestAge = ageMs; 
          oldestImei = imei; 
        }
      } else {
        noDataCount++;
      }
    }

    // Sync stale devices set in Redis
    if (recoveredImeis.length > 0 || newlyStaleImeis.length > 0) {
      const pipeline = redis.pipeline();
      if (recoveredImeis.length > 0) pipeline.srem(staleKey, ...recoveredImeis);
      if (newlyStaleImeis.length > 0) pipeline.sadd(staleKey, ...newlyStaleImeis);
      await pipeline.exec().catch(() => {});
    }

    const total = devices.length;
    
    // Construct the payload
    const dashboardPayload: FleetDashboardPayload = {
      counts: summary,
      fleetKpis: {
        utilizationRate: total > 0 ? (summary.RUNNING / total) * 100 : 0,
        activeVehicles: summary.RUNNING + summary.IDLE + summary.STOPPED,
        inactiveVehicles: summary.INACTIVE + summary.NO_DATA,
        connectedDevices: freshDataCount,
        disconnectedDevices: total - freshDataCount,
      },
      fuelOverview: {
        vehiclesWithFuelData: fuelCount,
        vehiclesWithoutFuelData: total - fuelCount,
        fleetAverageFuelLevel: fuelCount > 0 ? fuelSum / fuelCount : 0,
        fleetTotalFuelLiters: fuelSum,
        lowFuelVehicles: lowFuelCount,
        lowFuelThreshold: LOW_FUEL_THRESHOLD,
        criticalFuelVehicles: criticalFuelCount,
        criticalFuelThreshold: CRITICAL_FUEL_THRESHOLD,
        fuelDistribution: fuelDist,
      },
      utilizationMetrics: {
        engineOnCount,
        engineOffCount: total - engineOnCount,
        engineOnRate: total > 0 ? (engineOnCount / total) * 100 : 0,
        movingCount,
        stationaryCount: total - movingCount,
        movingRate: total > 0 ? (movingCount / total) * 100 : 0,
        idleRate: total > 0 ? (summary.IDLE / total) * 100 : 0,
      },
      deviceHealth: {
        freshDataCount,
        staleDataCount,
        noDataCount,
        dataFreshnessRate: total > 0 ? (freshDataCount / total) * 100 : 0,
        oldestDataAge: oldestAge >= 0 ? formatAge(oldestAge) : "N/A",
        oldestDataAgeMs: Math.max(0, oldestAge),
        oldestDataImei: oldestImei,
      },
      activityFeed,
      changed: changedDevices,
      computedAt: new Date(nowMs).toISOString(),
    };

    // 4. Always update Redis and publish, since dashboard needs fresh numbers
    await updateFleetStatus(orgId, newStatusMap, summary, dashboardPayload);
    await publishFleetStatusUpdate(orgId, dashboardPayload);

  } catch (error) {
    console.error(`[FLEET_STATUS] Error recomputing status for org ${orgId}:`, error);
  }
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

/**
 * Recomputes fleet status for ALL organizations.
 * Used by the periodic cron job to catch time-based transitions.
 */
export async function recomputeAllOrgStatuses(): Promise<void> {
  try {
    const orgs = await prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    for (const org of orgs) {
      await recomputeFleetStatus(org.id);
    }
  } catch (error) {
    console.error(`[FLEET_STATUS] Error in global recompute:`, error);
  }
}
