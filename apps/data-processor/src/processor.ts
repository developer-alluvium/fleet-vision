import { prisma } from "@fleet-vision/db";

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

/**
 * Processes a single Kafka message containing telemetry data.
 *
 * For each message:
 *  1. Upserts the Device by IMEI (creates on first contact)
 *  2. Batch-inserts all TelemetryRecords in a single transaction
 */
export async function processTelemetryMessage(
  rawValue: Buffer | null
): Promise<void> {
  if (!rawValue) {
    console.warn("[PROCESSOR] Received null message value – skipping");
    return;
  }

  const message: TelemetryMessage = JSON.parse(rawValue.toString());
  const { imei, records, codec } = message;

  if (!imei || !records || records.length === 0) {
    console.warn("[PROCESSOR] Invalid message structure – skipping", {
      imei,
      recordCount: records?.length,
    });
    return;
  }

  console.log(
    `[PROCESSOR] Processing ${records.length} records from IMEI ${imei} (${codec})`
  );

  // Use a transaction for atomicity: device upsert + record inserts
  await prisma.$transaction(async (tx) => {
    // ── 1. Upsert Device by IMEI ─────────────────────────────
    const device = await tx.device.upsert({
      where: { imei },
      create: { imei },
      update: { updatedAt: new Date() },
    });

    // ── 2. Batch-insert TelemetryRecords ─────────────────────
    const telemetryData = records.map((record) => {
      // ── Build fuel sensor JSON (Escort TD BLE) ──────────────
      // AVL 331 = raw fuel level, AVL 29 = sensor battery %, AVL 25 = sensor temp °C
      const hasFs =
        record.io_elements["331"] !== undefined ||
        record.io_elements["29"] !== undefined ||
        record.io_elements["25"] !== undefined;

      const fuelSensor = hasFs
        ? {
            rawFuelLevel: record.io_elements["331"] ?? null,
            sensorBattery: record.io_elements["29"] ?? null,
            sensorTemp: record.io_elements["25"] ?? null,
          }
        : null;

      return {
        time: new Date(record.timestamp),
        deviceId: device.id,
        latitude: record.latitude,
        longitude: record.longitude,
        speed: record.speed,
        altitude: record.altitude,
        angle: record.angle,
        satellites: record.satellites,
        priority: record.priority,
        isValid: record.satellites >= 3,
        eventId: record.event_id || null,
        odometer:
          record.io_elements["199"] || record.io_elements["16"] || null,
        fuelSensor,
        ioElements: record.io_elements as object,
      };
    });

    const result = await tx.telemetryRecord.createMany({
      data: telemetryData,
    });

    console.log(
      `[PROCESSOR] ✓ IMEI ${imei}: upserted device ${device.id}, inserted ${result.count} records`
    );
  });
}
