import { prisma, getDeviceAuth, updateLiveMap, publishLocationUpdate, publishJourneyRecords, Prisma, getCachedFuelSettings } from "@fleet-vision/db";

// ─── Types matching the Go TCP gateway's JSON output ─────────

interface AVLRecord {
  timestamp: string;
  priority: number;
  longitude: number;
  latitude: number;
  altitude: number;
  angle: number;
  satellites: number;
  speed: number;
  event_id?: number;
  io_elements: Record<string, number>;
}

interface TelemetryMessage {
  imei: string;
  records: AVLRecord[];
  codec: string;
  server_timestamp: string;
}

// ─── Counters ────────────────────────────────────────────────

let processedCount = 0;
let droppedCount = 0;

export function getProcessorStats() {
  return { processedCount, droppedCount };
}

/**
 * Processes a batch of Kafka messages containing telemetry data.
 *
 * For each message:
 *  1. Extract IMEI → Query Redis auth cache (HGETALL auth:{imei})
 *  2. If not authorized → drop the packet
 *  3. Inject orgId from Redis into each telemetry record
 *  4. Update the Live Map in Redis (HSET live_map:org:{orgId} {imei} {latest payload})
 *  5. Bulk insert all valid records into TimescaleDB
 */
export async function processTelemetryBatch(
  messages: Array<{ value: Buffer | null }>
): Promise<void> {
  const LIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
  const now = Date.now();

  // Collect all valid records with their orgIds
  const validRecords: Array<{
    time: Date;
    imei: string;
    organizationId: string;
    latitude: number | null;
    longitude: number | null;
    speed: number | null;
    ignition: boolean;
    gsmSignal: number | null;
    externalVoltage: number | null;
    internalBatteryVoltage: number | null;
    gnssStatus: number | null;
    batteryLevel: number | null;
    fuelLevelRaw: number | null;
    movement: boolean | null;
    angle: number | null;
    odometer: number | null;
    tripOdometer: number | null;
  }> = [];

  // Track live map updates to batch at the end
  const liveMapUpdates: Map<
    string,
    { orgId: string; imei: string; payload: object }
  > = new Map();

  // Track ALL individual records per device for journey stream publishing
  const journeyRecords: Map<
    string,
    {
      orgId: string;
      records: Array<{
        latitude: number | null;
        longitude: number | null;
        speed: number | null;
        angle: number | null;
        ignition: boolean;
        odometer: number | null;
        timestamp: string;
      }>;
    }
  > = new Map();

  for (const msg of messages) {
    if (!msg.value) continue;

    let message: TelemetryMessage;
    try {
      message = JSON.parse(msg.value.toString());
    } catch (err) {
      console.warn("[PROCESSOR] Invalid JSON in message – skipping:", err);
      droppedCount++;
      continue;
    }

    const { imei, records } = message;

    if (!imei || !records || records.length === 0) {
      console.warn("[PROCESSOR] Invalid message structure – skipping", {
        imei,
        recordCount: records?.length,
      });
      droppedCount++;
      continue;
    }

    // ── 1. Query Redis auth cache ──────────────────────────
    const auth = await getDeviceAuth(imei);
    if (!auth) {
      console.warn(
        `[PROCESSOR] ✗ Unauthorized IMEI ${imei} – dropping ${records.length} records`
      );
      droppedCount++;
      continue;
    }

    const { orgId } = auth;
    const fuelSettings = await getCachedFuelSettings(imei);

    // ── 2. Build telemetry records with orgId injected ─────
    // Also collect per-device journey records for SSE publishing
    if (!journeyRecords.has(imei)) {
      journeyRecords.set(imei, { orgId, records: [] });
    }
    const deviceJourney = journeyRecords.get(imei)!;

    console.log(
      `[PROCESSOR] 📡 Processing ${records.length} record(s) for IMEI: ${imei} | BLE Channel: ${fuelSettings?.bleFuelChannel ?? "None"}`
    );

    for (const record of records) {
      // Detect ignition from io_elements (AVL ID 239 is standard for ignition)
      const ignition =
        record.io_elements["239"] === 1 ||
        record.io_elements["ignition"] === 1 ||
        false;

      let fuelLevelRaw: number | null = null;

      if (fuelSettings?.bleFuelChannel) {
        const ioMapping = { 1: 270, 2: 273, 3: 276, 4: 279 };
        const ioId = ioMapping[fuelSettings.bleFuelChannel as keyof typeof ioMapping];
        if (ioId) {
          fuelLevelRaw = record.io_elements[String(ioId)] ?? null;
        }
      }

      console.log(
        `[PROCESSOR] ⛽ IMEI: ${imei} | Lat: ${record.latitude}, Lng: ${record.longitude} | Speed: ${record.speed} | Fuel Level Raw: ${fuelLevelRaw ?? "N/A"} | IO Elements:`,
        record.io_elements
      );

      validRecords.push({
        time: new Date(record.timestamp),
        imei,
        organizationId: orgId,
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        speed: record.speed ?? null,
        angle: record.angle ?? null,
        ignition,
        gsmSignal: record.io_elements["21"] ?? null,
        externalVoltage: record.io_elements["66"] ?? null,
        internalBatteryVoltage: record.io_elements["67"] ?? null,
        gnssStatus: record.io_elements["69"] ?? null,
        batteryLevel: record.io_elements["113"] ?? null,
        fuelLevelRaw,
        movement: record.io_elements["240"] !== undefined ? record.io_elements["240"] === 1 : null,
        odometer: record.io_elements["16"] ?? null,
        tripOdometer: record.io_elements["199"] ?? null,
      });

      // Collect for journey stream (every individual record)
      deviceJourney.records.push({
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        speed: record.speed ?? null,
        angle: record.angle ?? null,
        ignition,
        odometer: record.io_elements["16"] ?? null,
        timestamp: record.timestamp,
      });
    }

    // ── 3. Prepare live map update (latest record per device) ──
    // Sort just in case device sent them out of order in the same packet
    const sortedRecords = [...records].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const latestRecord = sortedRecords[sortedRecords.length - 1];
    
    let latestFuelLevelRaw: number | null = null;

    if (fuelSettings?.bleFuelChannel) {
      const ioMapping = { 1: 270, 2: 273, 3: 276, 4: 279 };
      const ioId = ioMapping[fuelSettings.bleFuelChannel as keyof typeof ioMapping];
      if (ioId) {
        latestFuelLevelRaw = latestRecord.io_elements[String(ioId)] ?? null;
      }
    }

    // Only update the live map (and fleet SSE stream) if this is actually a RECENT record.
    // If the device is uploading old buffered data, we don't want to overwrite its
    // current live location on the map with a position from 2 hours ago!
    if (now - new Date(latestRecord.timestamp).getTime() < LIVE_THRESHOLD_MS) {
      liveMapUpdates.set(imei, {
        orgId,
        imei,
        payload: {
          imei,
          latitude: latestRecord.latitude,
          longitude: latestRecord.longitude,
          speed: latestRecord.speed,
          angle: latestRecord.angle,
          ignition:
            latestRecord.io_elements["239"] === 1 ||
            latestRecord.io_elements["ignition"] === 1 ||
            false,
          fuelLevelRaw: latestFuelLevelRaw,
          odometer: latestRecord.io_elements["16"] ?? null,
          timestamp: latestRecord.timestamp,
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  if (validRecords.length === 0) {
    return;
  }

  // ── 4. Bulk insert into TimescaleDB ────────────────────
  const result = await prisma.telemetryRecord.createMany({
    data: validRecords,
  });

  processedCount += result.count;

  console.log(
    `[PROCESSOR] ✓ Bulk inserted ${result.count} records from ${liveMapUpdates.size} devices`
  );

  // ── 5. Update Live Map in Redis and Publish via Pub/Sub ──
  const liveMapPromises = Array.from(liveMapUpdates.values()).map(
    ({ orgId, imei, payload }) => Promise.all([
      updateLiveMap(orgId, imei, payload),
      publishLocationUpdate(orgId, imei, payload),
    ])
  );
  await Promise.all(liveMapPromises);

  // ── 6. Publish only RECENT records to journey Pub/Sub channels ──
  // Old buffered records (from device offline periods) are already saved in
  // TimescaleDB above and will be served via the journey:history SSE event.
  // Only truly recent records (within last 2 minutes) should go to the live
  // SSE stream to avoid confusing the frontend with out-of-order old data.
  const journeyPromises = Array.from(journeyRecords.entries()).map(
    ([deviceImei, { orgId, records }]) => {
      // Filter: only publish records whose timestamp is within the live threshold
      const liveRecords = records.filter(
        (r) => now - new Date(r.timestamp).getTime() < LIVE_THRESHOLD_MS
      );

      if (liveRecords.length === 0) return Promise.resolve();

      if (liveRecords.length < records.length) {
        console.log(
          `[PROCESSOR] IMEI ${deviceImei}: publishing ${liveRecords.length}/${records.length} recent records to SSE (${records.length - liveRecords.length} buffered records saved to DB only)`
        );
      }

      // Sort chronologically before publishing
      liveRecords.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      return publishJourneyRecords(orgId, deviceImei, liveRecords);
    }
  );
  await Promise.all(journeyPromises);
}
