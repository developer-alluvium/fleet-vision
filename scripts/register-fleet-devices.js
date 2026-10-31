#!/usr/bin/env node
/**
 * scripts/register-fleet-devices.js
 *
 * Registers and assigns GPS tracking devices and vehicles into PostgreSQL
 * and authorizes them in Redis cache for real-time telemetry processing.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const fleetData = [
  // ── Sheet 1 ─────────────────────────────────────────────────────────────
  { imei: "862272087994762", plateNumber: "GJ18BV9156" },
  { imei: "862272088030152", plateNumber: "GJ18AU8480" },
  { imei: "862272088029998", plateNumber: "GJ18AZ4229" },
  { imei: "862272087994721", plateNumber: null }, // Unassigned
  { imei: "862272087994812", plateNumber: "GJ18AX6955" },
  { imei: "862272088030103", plateNumber: "GJ12BT7142" },
  { imei: "862272087994713", plateNumber: "GJ18AV7468" },
  { imei: "862272087994820", plateNumber: "GJ12BX8779" },
  { imei: "862272087991446", plateNumber: "GJ18AX6284" },
  { imei: "862272086797943", plateNumber: "GJ01CX2097" },
  { imei: "862272087082899", plateNumber: "GJ18BW7814" },
  { imei: "862272087084606", plateNumber: "GJ12Z1090" },
  { imei: "862272087048205", plateNumber: "GJ15X8939" },
  { imei: "862272087048213", plateNumber: null, note: "ready to install" },
  { imei: "862272088106390", plateNumber: "GJ18AZ4495" },
  { imei: "862272086774074", plateNumber: "GJ08W8599" },
  { imei: "862272088106200", plateNumber: "GJ16AU5412" },
  { imei: "862272087048221", plateNumber: "GJ18AZ0849" },
  { imei: "862272088106341", plateNumber: null, note: "ready to install" },
  { imei: "862272086739010", plateNumber: "GJ18AZ5394" },

  // ── Sheet 2 ─────────────────────────────────────────────────────────────
  { imei: "862272087988137", plateNumber: "GJ18AV4735" },
  { imei: "862272087023190", plateNumber: "GJ01CV4935" },
  { imei: "862272086756501", plateNumber: "GJ09Z4266" },
  { imei: "862272087023117", plateNumber: "GJ1AU4504" },
  { imei: "862272086774280", plateNumber: "GJ18AV8971" },
  { imei: "862272087992311", plateNumber: "GJ18BV8816" },
  { imei: "862272086766476", plateNumber: "GJ12Z3234" },
  { imei: "862272088030236", plateNumber: "GJ18BV6050" },
  { imei: "862272086766526", plateNumber: "GJ12Z2989" },
  { imei: "862272087994051", plateNumber: "GJ20U7188" },
];

async function main() {
  console.log('Connecting to PostgreSQL and Redis...');

  // 1. Get or find target organization ("Suraj group of companies pvt ltd." by default)
  const targetOrgName =
    process.argv[2] ||
    process.env.ORG_NAME ||
    'Suraj group of companies pvt ltd.';

  let org = await prisma.organization.findFirst({
    where: {
      OR: [
        { name: { equals: targetOrgName, mode: 'insensitive' } },
        { name: { contains: 'Suraj', mode: 'insensitive' } },
        { id: targetOrgName },
      ],
    },
  });

  if (!org) {
    // Fall back to first active organization
    org = await prisma.organization.findFirst({
      where: { status: 'ACTIVE' },
    });
  }

  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: targetOrgName,
        status: 'ACTIVE',
        subscriptionPlan: 'ENTERPRISE',
      },
    });
    console.log(`Created organization: ${org.name} (${org.id})`);
  } else {
    console.log(`Using organization: "${org.name}" (${org.id})`);
  }

  let vehiclesCreated = 0;
  let devicesCreated = 0;
  let assignedCount = 0;

  for (const item of fleetData) {
    const imei = item.imei.trim();
    let vehicle = null;

    // 2. Register Vehicle if plateNumber is provided
    if (item.plateNumber) {
      const plate = item.plateNumber.trim().toUpperCase();
      vehicle = await prisma.vehicle.upsert({
        where: { plateNumber: plate },
        update: {
          organizationId: org.id,
          status: 'ACTIVE',
        },
        create: {
          plateNumber: plate,
          organizationId: org.id,
          status: 'ACTIVE',
          vehicleType: 'TRUCK',
        },
      });
      vehiclesCreated++;
    }

    // 3. Register Device and link to Vehicle
    if (vehicle) {
      // Unlink any other device currently linked to this vehicle to avoid unique constraint collision
      await prisma.device.updateMany({
        where: {
          vehicleId: vehicle.id,
          NOT: { imei },
        },
        data: { vehicleId: null },
      });
    }

    const device = await prisma.device.upsert({
      where: { imei },
      update: {
        organizationId: org.id,
        status: 'ONLINE',
        vehicleId: vehicle ? vehicle.id : null,
      },
      create: {
        imei,
        organizationId: org.id,
        status: 'ONLINE',
        vehicleId: vehicle ? vehicle.id : null,
      },
    });
    devicesCreated++;

    if (vehicle) {
      assignedCount++;
    }

    // 4. Authorize Device in Redis for data-processor O(1) packet lookup
    await redis.hset(`auth:${imei}`, {
      isAuthorized: 'true',
      orgId: org.id,
    });

    const label = vehicle ? `→ Vehicle ${vehicle.plateNumber}` : `(Unassigned / Standby)`;
    console.log(`✓ Device ${imei} ${label}`);
  }

  console.log('\n=========================================');
  console.log(`Total Devices Registered:  ${devicesCreated}`);
  console.log(`Total Vehicles Registered: ${vehiclesCreated}`);
  console.log(`Assigned Pairs:            ${assignedCount}`);
  console.log(`Redis Auth Cache Synced:   ${devicesCreated} devices`);
  console.log('=========================================\n');
}

main()
  .catch((e) => {
    console.error('Registration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
