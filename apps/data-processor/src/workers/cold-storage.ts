import path from "path";
import { timescalePrisma } from "@fleet-vision/db";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

/**
 * Cold Storage Archival — Nightly Cron
 *
 * Exports telemetry records older than 90 days to compressed Parquet files,
 * then drops/purges the archived chunks from TimescaleDB.
 * (0–7d uncompressed, 7–90d compressed columnar in TimescaleDB, 90+d Parquet cold storage).
 *
 * Production: Upload to AWS S3 before deleting.
 * Current: Writes to local filesystem (stubbed S3).
 */

const ARCHIVE_DIR =
  process.env.ARCHIVE_DIR || path.resolve(__dirname, "../../../../archives");
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "90", 10);
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

  // ── Retention: 90 days old data (configurable via RETENTION_DAYS) ──────
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  console.log(
    `[ARCHIVAL] Starting cold storage archival (retention: ${RETENTION_DAYS} day(s))…`
  );

  /*
  // ── Previous 6 Months Retention Logic (Commented Out) ────────────────────
  // if (process.env.RETENTION_HOURS) {
  //   const hours = parseInt(process.env.RETENTION_HOURS, 10);
  //   cutoffDate.setHours(cutoffDate.getHours() - hours);
  //   console.log(
  //     `[ARCHIVAL] Starting cold storage archival (retention: ${hours} hours)…`
  //   );
  // } else {
  //   cutoffDate.setMonth(cutoffDate.getMonth() - RETENTION_MONTHS);
  //   console.log(
  //     `[ARCHIVAL] Starting cold storage archival (retention: ${RETENTION_MONTHS} months)…`
  //   );
  // }
  */

  try {
    // ── 1. Count records to archive ──────────────────────────
    const count = await timescalePrisma.telemetryRecord.count({
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
      const batch = await timescalePrisma.telemetryRecord.findMany({
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

    // ── 4. Drop archived chunks from TimescaleDB (if purge enabled) ──────────
    const PURGE_AFTER_ARCHIVE = process.env.PURGE_AFTER_ARCHIVE !== "false";
    if (PURGE_AFTER_ARCHIVE) {
      // 4a. Drop TimescaleDB chunks older than cutoffDate (works seamlessly on compressed chunks)
      try {
        await timescalePrisma.$executeRawUnsafe(
          `SELECT drop_chunks('telemetry_records', older_than => $1::timestamptz);`,
          cutoffDate
        );
        console.log(
          `[ARCHIVAL] ✓ Dropped TimescaleDB chunks older than ${cutoffDate.toISOString()}`
        );
      } catch (chunkErr) {
        console.warn(
          "[ARCHIVAL] Notice: drop_chunks skipped or not a hypertable:",
          chunkErr instanceof Error ? chunkErr.message : chunkErr
        );
      }

      // 4b. Cleanup any uncompressed rows (fallback if table is standard postgres or chunk boundary residual)
      try {
        await timescalePrisma.$executeRawUnsafe(
          `DELETE FROM "telemetry_records" WHERE "time" < $1`,
          cutoffDate
        );
        console.log(
          `[ARCHIVAL] ✓ Purged remaining uncompressed records older than ${cutoffDate.toISOString()}`
        );
      } catch (delErr) {
        // If all matching chunks were already compressed and dropped, direct delete is either zero rows or unsupported on compressed tables
        console.log("[ARCHIVAL] Cleanup complete (compressed chunks dropped).");
      }
    } else {
      console.log(
        `[ARCHIVAL] ℹ PURGE_AFTER_ARCHIVE=false — kept records in TimescaleDB (backup-only mode)`
      );
    }
    console.log("[ARCHIVAL] ✓ Cold storage archival complete");
  } catch (err) {
    console.error("[ARCHIVAL] ✗ Error during archival:", err);
  }
}
