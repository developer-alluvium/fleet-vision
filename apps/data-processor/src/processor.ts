import {
  prisma,
  timescalePrisma,
  getDeviceAuth,
  updateLiveMap,
  publishLocationUpdate,
  publishJourneyRecords,
  Prisma,
  getCachedFuelSettings,
  getCachedCalibrationTable,
  rawToLiters,
} from "@fleet-vision/db";
import { recomputeFleetStatus } from "./workers/fleet-status";
import { batchCheckGeofencesForOrgs } from "./workers/geofence-worker";
import { batchCheckSpeedAlerts } from "./workers/speed-worker";
import {
  shouldSaveToTimescale,
  getDownsamplingStats,
} from "./workers/downsampling-engine";

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
  return {
    processedCount,
    droppedCount,
    ...getDownsamplingStats(),
  };
}

/**
 * Processes a batch of Kafka messages containing telemetry data.
 *
 * Implements the Dual-Path Telemetry Ingestion Architecture:
 *  1. Authenticates IMEI against Redis cache.
 *  2. HOT PATH: Every incoming 1-2s packet is pushed to Redis Live Map and SSE stream (Zero disk cost).
 *  3. COLD PATH GATEKEEPER: Evaluates Golden Triangle (Time >= 15s, Dist >= 50m, Angle >= 30°, Events).
 *     Only approved checkpoints are written to TimescaleDB, eliminating ~80-85% redundant disk writes.
 *  4. Evaluates real-time geofence breaches and speed alerts on active frames.
 */
export async function processTelemetryBatch(
  messages: Array<{ value: Buffer | null }>
): Promise<void> {
  const LIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
  const now = Date.now();

  // Cold Path: Filtered records to be persisted to TimescaleDB
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
    fuelLevelLiters: number | null;
    movement: boolean | null;
    angle: number | null;
    odometer: number | null;
    tripOdometer: number | null;
  }> = [];

  // All active incoming records (used for real-time safety alert & geofence checks)
  const allIncomingRecords: Array<{
    time: Date;
    imei: string;
    organizationId: string;
    latitude: number | null;
    longitude: number | null;
    speed: number | null;
    ignition: boolean;
  }> = [];

  // Track live map updates to batch in Redis
  const liveMapUpdates: Map<
    string,
    { orgId: string; imei: string; payload: object }
  > = new Map();

  // Track ALL individual records per device for high-frequency journey stream publishing
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
    const calibrationTable = await getCachedCalibrationTable(imei);

    // ── 2. Build telemetry records with orgId injected ─────
    if (!journeyRecords.has(imei)) {
      journeyRecords.set(imei, { orgId, records: [] });
    }
    const deviceJourney = journeyRecords.get(imei)!;

    for (const record of records) {
      // Detect ignition from io_elements (AVL ID 239 is standard for ignition)
      // Fallback: if vehicle is moving, assume ignition is ON
      const ignition =
        record.io_elements["239"] === 1 ||
        record.io_elements["ignition"] === 1 ||
        record.io_elements["1"] === 1 ||
        (record.speed !== undefined && record.speed > 0) ||
        false;

      let fuelLevelRaw: number | null = null;
      let fuelLevelLiters: number | null = null;

      const channel = fuelSettings?.bleFuelChannel || 1;
      const ioMapping = { 1: 270, 2: 273, 3: 276, 4: 279 };
      const ioId = ioMapping[channel as keyof typeof ioMapping];
      if (ioId) {
        fuelLevelRaw = record.io_elements[String(ioId)] ?? null;
        if (fuelLevelRaw !== null && calibrationTable) {
          fuelLevelLiters = rawToLiters(fuelLevelRaw, calibrationTable);
        }
      }

      // Record for safety checks
      allIncomingRecords.push({
        time: new Date(record.timestamp),
        imei,
        organizationId: orgId,
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        speed: record.speed ?? null,
        ignition,
      });

      // ── HOT PATH: Collect every 1-2s point for real-time journey SSE stream ──
      deviceJourney.records.push({
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        speed: record.speed ?? null,
        angle: record.angle ?? null,
        ignition,
        odometer: record.io_elements["16"] ?? null,
        timestamp: record.timestamp,
      });

      // ── COLD PATH GATEKEEPER: Smart Downsampling Filter for TimescaleDB ──
      const decision = shouldSaveToTimescale(imei, {
        timestamp: record.timestamp,
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        angle: record.angle ?? null,
        speed: record.speed ?? null,
        ignition,
        eventId: record.event_id,
      });

      if (decision.shouldSave) {
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
          fuelLevelLiters,
          movement:
            record.io_elements["240"] !== undefined
              ? record.io_elements["240"] === 1
              : null,
          odometer: record.io_elements["16"] ?? null,
          tripOdometer: record.io_elements["199"] ?? null,
        });
      }
    }

    // ── 3. Prepare live map update (latest record per device) ──
    const sortedRecords = [...records].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const latestRecord = sortedRecords[sortedRecords.length - 1];

    let latestFuelLevelRaw: number | null = null;
    let latestFuelLevelLiters: number | null = null;

    const channel = fuelSettings?.bleFuelChannel || 1;
    const ioMapping = { 1: 270, 2: 273, 3: 276, 4: 279 };
    const ioId = ioMapping[channel as keyof typeof ioMapping];
    if (ioId) {
      latestFuelLevelRaw = latestRecord.io_elements[String(ioId)] ?? null;
      if (latestFuelLevelRaw !== null && calibrationTable) {
        latestFuelLevelLiters = rawToLiters(
          latestFuelLevelRaw,
          calibrationTable
        );
      }
    }

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
            latestRecord.io_elements["1"] === 1 ||
            (latestRecord.speed !== undefined && latestRecord.speed > 0) ||
            false,
          fuelLevelRaw: latestFuelLevelRaw,
          fuelLevelLiters: latestFuelLevelLiters,
          odometer: latestRecord.io_elements["16"] ?? null,
          timestamp: latestRecord.timestamp,
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  // ── 4. HOT PATH EXECUTION: Always update Redis and publish real-time streams ──
  const liveMapPromises = Array.from(liveMapUpdates.values()).map(
    ({ orgId, imei, payload }) =>
      Promise.all([
        updateLiveMap(orgId, imei, payload),
        publishLocationUpdate(orgId, imei, payload),
      ])
  );
  await Promise.all(liveMapPromises);

  // Publish recent records to journey SSE streams
  const journeyPromises = Array.from(journeyRecords.entries()).map(
    ([deviceImei, { orgId, records }]) => {
      const liveRecords = records.filter(
        (r) => now - new Date(r.timestamp).getTime() < LIVE_THRESHOLD_MS
      );

      if (liveRecords.length === 0) return Promise.resolve();

      liveRecords.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      return publishJourneyRecords(orgId, deviceImei, liveRecords);
    }
  );
  await Promise.all(journeyPromises);

  // Recompute Fleet Status for affected organizations
  const affectedOrgIds = new Set(
    Array.from(liveMapUpdates.values()).map((u) => u.orgId)
  );
  await Promise.all(
    Array.from(affectedOrgIds).map((orgId) => recomputeFleetStatus(orgId))
  );

  // ── 5. COLD PATH EXECUTION: Bulk insert filtered checkpoints to TimescaleDB ──
  if (validRecords.length > 0) {
    try {
      const result = await timescalePrisma.telemetryRecord.createMany({
        data: validRecords,
        skipDuplicates: true,
      });
      processedCount += result.count;
    } catch (dbErr) {
      console.error("[PROCESSOR] ✗ TimescaleDB bulk insert error:", dbErr);
    }
  }

  // ── 6. Alert & Geofence Checks on active frames ────────────
  if (allIncomingRecords.length > 0) {
    await batchCheckGeofencesForOrgs(affectedOrgIds, allIncomingRecords);
    await batchCheckSpeedAlerts(allIncomingRecords);
  }
}
