import * as dotenv from "dotenv";
dotenv.config();

import { prisma, authorizeDevice } from "./packages/db/src";

async function main() {
  console.log("Fetching devices from PostgreSQL...");
  const devices = await prisma.device.findMany();
  console.log(`Found ${devices.length} devices.`);
  
  let authorizedCount = 0;
  for (const device of devices) {
    await authorizeDevice(device.imei, device.organizationId);
    console.log(`Authorized device IMEI: ${device.imei} for Org: ${device.organizationId}`);
    authorizedCount++;
  }
  
  console.log(`Successfully synced ${authorizedCount} devices to Redis auth cache.`);
}

main().catch(console.error).finally(() => process.exit());
