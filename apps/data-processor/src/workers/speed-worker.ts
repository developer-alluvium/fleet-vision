import {
  prisma,
  checkAndSetSpeedState,
  publishSpeedAlert,
} from "@fleet-vision/db";

/**
 * Batch checks speed for all valid telemetry records.
 * 
 * Logic:
 * 1. For each record, if speed is present, compare to the device's speed limit.
 * 2. Speed limit is Vehicle.speedLimitKmh, fallback to Organization.globalSpeedLimitKmh.
 * 3. Use checkAndSetSpeedState to handle hysteresis (only trigger once when crossing the threshold).
 * 4. Create an Alert record and publish an SSE event.
 */
export async function batchCheckSpeedAlerts(
  records: Array<{
    organizationId: string;
    imei: string;
    latitude: number | null;
    longitude: number | null;
    speed: number | null;
    time: Date;
  }>
): Promise<void> {
  // Extract unique IMEIs and OrgIds
  const imeis = new Set<string>();
  const orgIds = new Set<string>();
  for (const r of records) {
    imeis.add(r.imei);
    orgIds.add(r.organizationId);
  }

  if (imeis.size === 0) return;

  try {
    // 1. Fetch organization default limits
    const orgs = await prisma.organization.findMany({
      where: { id: { in: Array.from(orgIds) } },
      select: { id: true, globalSpeedLimitKmh: true },
    });
    const orgLimits = new Map<string, number>();
    for (const org of orgs) {
      orgLimits.set(org.id, org.globalSpeedLimitKmh || 100); // default to 100 if null
    }

    // 2. Fetch vehicle specific limits
    const devices = await prisma.device.findMany({
      where: { imei: { in: Array.from(imeis) } },
      select: { imei: true, vehicle: { select: { speedLimitKmh: true } } },
    });
    const vehicleLimits = new Map<string, number | null>();
    for (const dev of devices) {
      vehicleLimits.set(dev.imei, dev.vehicle?.speedLimitKmh || null);
    }

    // 3. Process records (only latest per device to avoid duplicate alerts in same batch)
    const latestPerDevice = new Map<string, typeof records[0]>();
    for (const r of records) {
      if (r.speed == null || r.latitude == null || r.longitude == null) continue;
      const existing = latestPerDevice.get(r.imei);
      if (!existing || r.time.getTime() > existing.time.getTime()) {
        latestPerDevice.set(r.imei, r);
      }
    }

    const alertsToCreate: any[] = [];

    for (const point of latestPerDevice.values()) {
      const globalLimit = orgLimits.get(point.organizationId) || 100;
      const vehicleLimit = vehicleLimits.get(point.imei);
      const effectiveLimit = vehicleLimit != null ? vehicleLimit : globalLimit;

      const isSpeeding = point.speed! > effectiveLimit;

      // Update state machine and get transition event
      const transition = await checkAndSetSpeedState(point.organizationId, point.imei, isSpeeding);

      if (transition) {
        // Create an alert on OVERSPEED or RESOLVED
        const alert = {
          category: "SPEED",
          organizationId: point.organizationId,
          imei: point.imei,
          eventType: transition,
          latitude: point.latitude!,
          longitude: point.longitude!,
          speed: point.speed,
          metadata: {
            speedLimit: effectiveLimit
          },
          timestamp: point.time,
        };

        alertsToCreate.push(alert);

        // Publish to SSE
        await publishSpeedAlert(point.organizationId, {
          imei: point.imei,
          eventType: transition,
          latitude: point.latitude!,
          longitude: point.longitude!,
          speed: point.speed!,
          speedLimit: effectiveLimit,
          timestamp: point.time.toISOString(),
        });
      }
    }

    // 4. Bulk insert alerts
    if (alertsToCreate.length > 0) {
      await prisma.alert.createMany({
        data: alertsToCreate
      });
      console.log(`[SPEED] Created ${alertsToCreate.length} speed alerts`);
    }

  } catch (err) {
    console.error(`[SPEED] Error processing speed alerts:`, err);
  }
}
