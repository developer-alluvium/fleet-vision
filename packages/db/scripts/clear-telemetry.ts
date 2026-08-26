import * as dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src";

async function main() {
  console.log("Starting safe deletion of all telemetry records...");
  
  // Safely delete only telemetry records.
  // This will NOT delete devices from PostgreSQL, and will NOT touch the Redis auth cache.
  const result = await prisma.telemetryRecord.deleteMany();
  
  console.log(`Successfully deleted ${result.count} telemetry records.`);
  console.log("Device registrations and Redis auth cache remain fully intact.");
}

main().catch(console.error).finally(() => process.exit());
