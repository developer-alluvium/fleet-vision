import path from "path";
import dotenv from "dotenv";

// Load environment variables from the monorepo root, falling back to local .env
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

import { startConsumer, stopConsumer } from "./consumer";
import { processTelemetryBatch, getProcessorStats } from "./processor";
import { archiveColdStorage } from "./workers/cold-storage";
import { prisma, redis } from "@fleet-vision/db";
import cron from "node-cron";

// ─── Main Entry Point ────────────────────────────────────────

async function main(): Promise<void> {
  console.log("┌──────────────────────────────────────────────┐");
  console.log("│  Fleet Vision · Data Processor (Enterprise)  │");
  console.log("└──────────────────────────────────────────────┘");

  // Verify database connectivity
  try {
    await prisma.$connect();
    console.log("[DB] ✓ Connected to TimescaleDB");
  } catch (err) {
    console.error("[DB] ✗ Failed to connect to TimescaleDB:", err);
    process.exit(1);
  }

  // Verify Redis connectivity
  try {
    await redis.connect();
    const pong = await redis.ping();
    console.log(`[REDIS] ✓ Connected to Redis (${pong})`);
  } catch (err) {
    console.error("[REDIS] ✗ Failed to connect to Redis:", err);
    process.exit(1);
  }

  // Start consuming from Kafka with batch processing
  await startConsumer(async (messages) => {
    await processTelemetryBatch(messages);
  });

  console.log("[WORKER] ✓ Data processor is running. Waiting for messages…");

  // Log stats every 30 seconds
  setInterval(() => {
    const stats = getProcessorStats();
    if (stats.processedCount > 0 || stats.droppedCount > 0) {
      console.log(
        `[STATS] Processed: ${stats.processedCount} | Dropped: ${stats.droppedCount}`
      );
    }
  }, 30_000);

  // Schedule Cold Storage Archival (Daily at 2:30 PM)
  const ENABLE_COLD_STORAGE = process.env.ENABLE_COLD_STORAGE === "true";
  if (ENABLE_COLD_STORAGE) {
    cron.schedule("30 14 * * *", () => {
      console.log("[CRON] Triggering scheduled cold storage archival...");
      archiveColdStorage().catch((err) => {
        console.error("[CRON] ✗ Error during scheduled archival:", err);
      });
    });
  } else {
    console.log("[CRON] Cold storage archival cron is disabled via ENABLE_COLD_STORAGE flag.");
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[SHUTDOWN] Received ${signal} – cleaning up…`);

  try {
    await stopConsumer();
    await redis.quit();
    await prisma.$disconnect();
    console.log("[SHUTDOWN] ✓ Clean shutdown complete");
  } catch (err) {
    console.error("[SHUTDOWN] ✗ Error during shutdown:", err);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start
main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
