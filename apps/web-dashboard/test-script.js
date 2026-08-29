const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function run() {
  const org = await prisma.organization.findFirst();
  if (!org) {
    console.log("No organization found");
    return;
  }
  const device = await prisma.device.findFirst({ where: { organizationId: org.id } });
  
  console.log("API_KEY:", org.apiKey);
  if (device) {
    console.log("IMEI:", device.imei);
  } else {
    console.log("No devices found for org");
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
