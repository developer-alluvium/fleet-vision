import { prisma, getDeviceAuth, updateLiveMap, publishLocationUpdate, publishJourneyRecords, Prisma } from "@fleet-vision/db";

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
  // Collect all valid records with their orgIds
  const validRecords: Array<{
    time: Date;
    imei: string;
    organizationId: string;
    latitude: number | null;
    longitude: number | null;
    speed: number | null;
    ignition: boolean;
    ioElements: Prisma.InputJsonValue | undefined;
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
        ignition: boolean;
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

    // ── 2. Build telemetry records with orgId injected ─────
    // Also collect per-device journey records for SSE publishing
    if (!journeyRecords.has(imei)) {
      journeyRecords.set(imei, { orgId, records: [] });
    }
    const deviceJourney = journeyRecords.get(imei)!;

    for (const record of records) {
      // Detect ignition from io_elements (AVL ID 239 is standard for ignition)
      const ignition =
        record.io_elements["239"] === 1 ||
        record.io_elements["ignition"] === 1 ||
        false;

      validRecords.push({
        time: new Date(record.timestamp),
        imei,
        organizationId: orgId,
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        speed: record.speed ?? null,
        angle: record.angle ?? null,
        ignition,
        ioElements: (record.io_elements as Prisma.InputJsonValue) ?? undefined,
      });

      // Collect for journey stream (every individual record)
      deviceJourney.records.push({
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        speed: record.speed ?? null,
        angle: record.angle ?? null,
        ignition,
        timestamp: record.timestamp,
      });
    }

    // ── 3. Prepare live map update (latest record per device) ──
    const latestRecord = records[records.length - 1];
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
        timestamp: latestRecord.timestamp,
        updatedAt: new Date().toISOString(),
      },
    });
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

  // ── 6. Publish ALL individual records to journey Pub/Sub channels ──
  // This enables the journey SSE stream to receive every GPS point in real-time
  const journeyPromises = Array.from(journeyRecords.entries()).map(
    ([deviceImei, { orgId, records }]) => {
      // Sort records chronologically before publishing
      records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      return publishJourneyRecords(orgId, deviceImei, records);
    }
  );
  await Promise.all(journeyPromises);
}
