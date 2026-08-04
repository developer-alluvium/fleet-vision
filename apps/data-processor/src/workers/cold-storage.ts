import { createWriteStream } from "fs";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";
import { prisma } from "@fleet-vision/db";

/**
 * Cold Storage Archival — Nightly Cron
 *
 * Exports telemetry records older than 6 months to compressed CSV files,
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
  console.log(
    `[ARCHIVAL] Starting cold storage archival (retention: ${RETENTION_MONTHS} months)…`
  );

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - RETENTION_MONTHS);

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

    // ── 2. Export to compressed CSV ──────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `telemetry_archive_${timestamp}.csv.gz`;
    const filepath = path.join(ARCHIVE_DIR, filename);

    // Ensure archive directory exists
    const { mkdir } = await import("fs/promises");
    await mkdir(ARCHIVE_DIR, { recursive: true });

    // Stream records → CSV → gzip → file
    let offset = 0;
    let totalExported = 0;

    const csvHeader =
      "id,time,imei,organization_id,latitude,longitude,speed,ignition,io_elements\n";

    const gzip = createGzip();
    const output = createWriteStream(filepath);

    const csvStream = new Readable({
      async read() {
        if (offset === 0) {
          this.push(csvHeader);
        }

        const batch = await prisma.telemetryRecord.findMany({
          where: { time: { lt: cutoffDate } },
          orderBy: { time: "asc" },
          take: BATCH_SIZE,
          skip: offset,
        });

        if (batch.length === 0) {
          this.push(null); // End stream
          return;
        }

        const csvRows = batch
          .map(
            (r) =>
              `${r.id},${r.time.toISOString()},${r.imei},${r.organizationId},` +
              `${r.latitude ?? ""},${r.longitude ?? ""},${r.speed ?? ""},` +
              `${r.ignition},${JSON.stringify(r.ioElements ?? {}).replace(/,/g, ";")}`
          )
          .join("\n");

        this.push(csvRows + "\n");
        offset += batch.length;
        totalExported += batch.length;
      },
    });

    await pipeline(csvStream, gzip, output);

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
