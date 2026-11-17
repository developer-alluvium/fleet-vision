#!/usr/bin/env node
/**
 * scripts/seed-user.js
 *
 * Seeds or updates a local user with email and password linked to an organization.
 * Usage:
 *   node scripts/seed-user.js [EMAIL] [PASSWORD] [ORG_NAME]
 * Example:
 *   node scripts/seed-user.js webapp@alluvium.in Suraj@123 "Suraj group of companies pvt ltd."
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = (process.argv[2] || 'webapp@alluvium.in').toLowerCase().trim();
  const password = process.argv[3] || 'Suraj@123';
  const orgName = process.argv[4] || 'Suraj group of companies pvt ltd.';

  console.log(`[SEED] Seeding user "${email}" for organization "${orgName}"...`);

  // 1. Find or create Organization
  let org = await prisma.organization.findFirst({
    where: {
      OR: [
        { name: { equals: orgName, mode: 'insensitive' } },
        { name: { contains: 'Suraj', mode: 'insensitive' } },
      ],
    },
  });

  if (!org) {
    org = await prisma.organization.findFirst({
      where: { status: 'ACTIVE' },
    });
  }

  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: orgName,
        status: 'ACTIVE',
        subscriptionPlan: 'ENTERPRISE',
      },
    });
    console.log(`[SEED] Created new organization: "${org.name}" (ID: ${org.id})`);
  } else {
    console.log(`[SEED] Found organization: "${org.name}" (ID: ${org.id})`);
  }

  // 2. Hash Password
  const hashedPassword = await bcrypt.hash(password, 10);

  // 3. Upsert User
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      password: hashedPassword,
      organizationId: org.id,
      role: 'ADMIN',
    },
    create: {
      email,
      password: hashedPassword,
      role: 'ADMIN',
      organizationId: org.id,
    },
  });

  console.log('\n=========================================');
  console.log('✓ User created / updated successfully!');
  console.log(`  Email:           ${user.email}`);
  console.log(`  Role:            ${user.role}`);
  console.log(`  Organization:    ${org.name} (${org.id})`);
  console.log('=========================================\n');
}

main()
  .catch((err) => {
    console.error('[SEED] ✗ Error seeding user:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

