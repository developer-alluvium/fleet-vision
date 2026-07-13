import path from "path";
import dotenv from "dotenv";

// Load environment variables from the monorepo root, falling back to local .env
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();
import { startConsumer, stopConsumer } from "./consumer";
import { processTelemetryMessage } from "./processor";
import { prisma } from "@fleet-vision/db";

// ─── Main Entry Point ────────────────────────────────────────

async function main(): Promise<void> {
  console.log("┌──────────────────────────────────────────────┐");
  console.log("│     Fleet Vision · Data Processor Worker     │");
  console.log("└──────────────────────────────────────────────┘");

  // Verify database connectivity
  try {
    await prisma.$connect();
    console.log("[DB] ✓ Connected to PostgreSQL");
  } catch (err) {
    console.error("[DB] ✗ Failed to connect to PostgreSQL:", err);
    process.exit(1);
  }

  // Start consuming from Kafka
  await startConsumer(async ({ message }) => {
    await processTelemetryMessage(message.value);
  });

  console.log("[WORKER] ✓ Data processor is running. Waiting for messages…");
}

// ─── Graceful Shutdown ───────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[SHUTDOWN] Received ${signal} – cleaning up…`);

  try {
    await stopConsumer();
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
