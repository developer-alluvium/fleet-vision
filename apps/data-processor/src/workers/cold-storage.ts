import path from "path";
import { prisma } from "@fleet-vision/db";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

/**
 * Cold Storage Archival — Nightly Cron
 *
 * Exports telemetry records older than 6 months to compressed Parquet files,
 * then deletes the archived rows from TimescaleDB.
 *
 * Production: Upload to AWS S3 before deleting.
 * Current: Writes to local filesystem (stubbed S3).
 */

const ARCHIVE_DIR =
  process.env.ARCHIVE_DIR || path.resolve(__dirname, "../../../../archives");
const RETENTION_MONTHS = parseInt(process.env.RETENTION_MONTHS || "6", 10);
const BATCH_SIZE = 10000;

/**
 * Run the archival process.
 */
export async function archiveColdStorage(): Promise<void> {
  const ENABLE_COLD_STORAGE = process.env.ENABLE_COLD_STORAGE === "true";
  if (!ENABLE_COLD_STORAGE) {
    console.log("[ARCHIVAL] Cold storage is disabled via ENABLE_COLD_STORAGE flag. Skipping archival.");
    return;
  }

  const cutoffDate = new Date();
  if (process.env.RETENTION_HOURS) {
    const hours = parseInt(process.env.RETENTION_HOURS, 10);
    cutoffDate.setHours(cutoffDate.getHours() - hours);
    console.log(
      `[ARCHIVAL] Starting cold storage archival (retention: ${hours} hours)…`
    );
  } else {
    cutoffDate.setMonth(cutoffDate.getMonth() - RETENTION_MONTHS);
    console.log(
      `[ARCHIVAL] Starting cold storage archival (retention: ${RETENTION_MONTHS} months)…`
    );
  }

  try {
    // ── 1. Count records to archive ──────────────────────────
    const count = await prisma.telemetryRecord.count({
      where: {
        time: { lt: cutoffDate },
      },
    });

    if (count === 0) {
      console.log("[ARCHIVAL] ✓ No records older than cutoff — nothing to archive");
      return;
    }

    console.log(
      `[ARCHIVAL] Found ${count} records older than ${cutoffDate.toISOString()}`
    );

    // ── 2. Export to Parquet ─────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `telemetry_archive_${timestamp}.parquet`;
    const filepath = path.join(ARCHIVE_DIR, filename);

    // Ensure archive directory exists
    const { mkdir } = await import("fs/promises");
    await mkdir(ARCHIVE_DIR, { recursive: true });

    const schema = new ParquetSchema({
      id: { type: "UTF8" },
      time: { type: "TIMESTAMP_MILLIS" },
      imei: { type: "UTF8" },
      organizationId: { type: "UTF8" },
      latitude: { type: "DOUBLE", optional: true },
      longitude: { type: "DOUBLE", optional: true },
      speed: { type: "DOUBLE", optional: true },
      angle: { type: "DOUBLE", optional: true },
      ignition: { type: "BOOLEAN" },
      gsmSignal: { type: "INT32", optional: true },
      externalVoltage: { type: "INT32", optional: true },
      internalBatteryVoltage: { type: "INT32", optional: true },
      gnssStatus: { type: "INT32", optional: true },
      batteryLevel: { type: "INT32", optional: true },
      movement: { type: "BOOLEAN", optional: true },
      odometer: { type: "DOUBLE", optional: true },
      tripOdometer: { type: "DOUBLE", optional: true },
      fuelLevelRaw: { type: "INT32", optional: true },
      serverCreatedAt: { type: "TIMESTAMP_MILLIS" }
    });

    const writer = await ParquetWriter.openFile(schema, filepath);

    let offset = 0;
    let totalExported = 0;

    while (true) {
      const batch = await prisma.telemetryRecord.findMany({
        where: { time: { lt: cutoffDate } },
        orderBy: { time: "asc" },
        take: BATCH_SIZE,
        skip: offset,
      });

      if (batch.length === 0) break;

      for (const r of batch) {
        await writer.appendRow({
          id: r.id,
          time: r.time,
          imei: r.imei,
          organizationId: r.organizationId,
          latitude: r.latitude ?? null,
          longitude: r.longitude ?? null,
          speed: r.speed ?? null,
          angle: r.angle ?? null,
          ignition: r.ignition,
          gsmSignal: r.gsmSignal ?? null,
          externalVoltage: r.externalVoltage ?? null,
          internalBatteryVoltage: r.internalBatteryVoltage ?? null,
          gnssStatus: r.gnssStatus ?? null,
          batteryLevel: r.batteryLevel ?? null,
          movement: r.movement ?? null,
          odometer: r.odometer ?? null,
          tripOdometer: r.tripOdometer ?? null,
          fuelLevelRaw: r.fuelLevelRaw ?? null,
          serverCreatedAt: r.serverCreatedAt,
        });
      }

      offset += batch.length;
      totalExported += batch.length;
    }

    await writer.close();

    console.log(
      `[ARCHIVAL] ✓ Exported ${totalExported} records to ${filepath}`
    );

    // ── 3. Upload to S3 (STUBBED) ────────────────────────────
    // TODO: Implement AWS S3 upload when credentials are available
    // await s3.upload({ Bucket: 'fleet-vision-archives', Key: filename, Body: fs.createReadStream(filepath) })
    console.log(
      `[ARCHIVAL] ⚠ S3 upload stubbed — file saved locally at ${filepath}`
    );

    // ── 4. Delete archived rows from TimescaleDB ─────────────
    const deleted: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
      `DELETE FROM "telemetry_records" WHERE "time" < $1`,
      cutoffDate
    );

    console.log(
      `[ARCHIVAL] ✓ Deleted archived records from TimescaleDB (cutoff: ${cutoffDate.toISOString()})`
    );
    console.log("[ARCHIVAL] ✓ Cold storage archival complete");
  } catch (err) {
    console.error("[ARCHIVAL] ✗ Error during archival:", err);
  }
}
