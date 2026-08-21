import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const imeiToKeep = '862272087994820';
  
  console.log(`Deleting all telemetry records EXCEPT for IMEI: ${imeiToKeep}...`);
  
  const result = await prisma.telemetryRecord.deleteMany({
    where: {
      imei: {
        not: imeiToKeep
      }
    }
  });

  console.log(`Successfully deleted ${result.count} telemetry records.`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
