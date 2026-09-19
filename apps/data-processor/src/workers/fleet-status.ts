import {
  prisma,
  getLiveMap,
  getFleetStatusDetails,
  computeDeviceStatus,
  updateFleetStatus,
  publishFleetStatusUpdate,
} from "@fleet-vision/db";

// Thresholds from environment variables or defaults
const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MINUTES || "5", 10) * 60 * 1000;
const INACTIVE_THRESHOLD_MS = parseInt(process.env.INACTIVE_THRESHOLD_HOURS || "24", 10) * 60 * 60 * 1000;

/**
 * Recomputes the fleet status for a given organization and publishes any changes.
 * This is designed to be called efficiently after a telemetry batch, or periodically via cron.
 */
export async function recomputeFleetStatus(orgId: string): Promise<void> {
  const nowMs = Date.now();

  try {
    // 1. Fetch current registered devices (using DB for truth, though could be cached)
    // We only need IMEI to cross-reference with live map
    const devices = await prisma.device.findMany({
      where: { organizationId: orgId },
      select: { imei: true },
    });

    if (devices.length === 0) {
      return; // No devices, nothing to do
    }

    // 2. Fetch current live map (latest telemetry) & previous statuses
    const [liveMap, previousStatusMap] = await Promise.all([
      getLiveMap(orgId),
      getFleetStatusDetails(orgId),
    ]);

    // 3. Compute new status for each device and track changes
    const newStatusMap: Record<string, string> = {};
    const summary: Record<string, number> = {
      TOTAL: devices.length,
      RUNNING: 0,
      IDLE: 0,
      STOPPED: 0,
      INACTIVE: 0,
      NO_DATA: 0,
    };
    const changedDevices: Array<{ imei: string; previousStatus: string; newStatus: string }> = [];

    for (const device of devices) {
      const imei = device.imei;
      const payload = liveMap[imei] as any; // Cast from object to any to access properties safely based on our known structure
      
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
          previousStatus: prevStatus || 'NO_DATA',
          newStatus,
        });
      }
    }

    // 4. If any status changed OR we need to initialize, update Redis and publish
    // (We also update if previousStatusMap was empty to ensure summary exists)
    if (changedDevices.length > 0 || Object.keys(previousStatusMap).length === 0) {
      // Update Redis (Hash and Summary)
      await updateFleetStatus(orgId, newStatusMap, summary);

      // Publish diff for SSE
      await publishFleetStatusUpdate(orgId, summary, changedDevices);

      if (changedDevices.length > 0) {
        console.log(`[FLEET_STATUS] Org ${orgId}: ${changedDevices.length} status changes detected. summary=`, summary);
      }
    }
  } catch (error) {
    console.error(`[FLEET_STATUS] Error recomputing status for org ${orgId}:`, error);
  }
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
