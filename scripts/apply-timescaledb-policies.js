#!/usr/bin/env node
/**
 * scripts/apply-timescaledb-policies.js
 *
 * Applies the 3-tier lifecycle policies to TimescaleDB:
 *   1. Chunks 0–7 days: uncompressed hot data
 *   2. Chunks 7–90 days: native TimescaleDB columnar compression
 *   3. Chunks 90+ days: Parquet cold archival
 *
 * Usage:
 *   node scripts/apply-timescaledb-policies.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');

const dbUrl = process.env.TIMESCALE_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[POLICIES] ✗ Neither TIMESCALE_URL nor DATABASE_URL found in .env');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: dbUrl }
  }
});

async function main() {
  console.log('[POLICIES] Connecting to TimescaleDB...');
  
  const sqlFile = path.join(__dirname, 'apply-timescaledb-policies.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');

  try {
    await prisma.$executeRawUnsafe(sql);
    console.log('[POLICIES] ✓ Successfully applied TimescaleDB policies:');
    console.log('  - 0–7 days:  Keep uncompressed (hot storage)');
    console.log('  - 7–90 days: Native Columnar Compression (warm storage)');
    console.log('  - 90+ days:  Archival to Parquet via cold-storage worker (cold storage)');
  } catch (err) {
    console.error('[POLICIES] ✗ Error applying policies:', err.message || err);
  } finally {
    await prisma.$disconnect();
  }
}

main();

