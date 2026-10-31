#!/usr/bin/env node
/**
 * scripts/bridge-ec2-to-local-kafka.js
 *
 * Pulls the live telemetry stream from the remote EC2 TCP server (via HTTPS SSE)
 * and forwards every packet directly into your LOCAL Kafka broker (topic: telemetry-raw).
 *
 * This allows your local data-processor and local TimescaleDB to ingest real-time
 * vehicle GPS tracker telemetry while keeping your entire development pipeline local.
 *
 * Usage:
 *   npm run bridge:ec2
 *   OR
 *   node scripts/bridge-ec2-to-local-kafka.js [STREAM_URL] [KAFKA_BROKERS]
 */

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const https = require('https');
const http = require('http');
const { Kafka, logLevel } = require('kafkajs');

// ── Configuration ────────────────────────────────────────────────────────────
const STREAM_URL =
  process.argv[2] ||
  process.env.REMOTE_STREAM_URL ||
  'https://fleetvision.alvision.in/stream';

const KAFKA_BROKERS = (
  process.argv[3] ||
  process.env.KAFKA_BROKERS ||
  'localhost:9092'
).split(',');

const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'telemetry-raw';

console.log('┌──────────────────────────────────────────────────────────────┐');
console.log('│      Fleet Vision · EC2 Stream → Local Kafka Bridge          │');
console.log('├──────────────────────────────────────────────────────────────┤');
console.log(`│ Source Stream : ${STREAM_URL.padEnd(45)}│`);
console.log(`│ Local Kafka   : ${KAFKA_BROKERS.join(',').padEnd(45)}│`);
console.log(`│ Kafka Topic   : ${KAFKA_TOPIC.padEnd(45)}│`);
console.log('└──────────────────────────────────────────────────────────────┘\n');

// ── Initialize Local Kafka Producer ──────────────────────────────────────────
const kafka = new Kafka({
  clientId: 'fleet-vision-ec2-bridge',
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
});

const producer = kafka.producer();
let isProducerConnected = false;
let packetCount = 0;
let activeRequest = null;
let isShuttingDown = false;

async function startBridge() {
  try {
    process.stdout.write('[KAFKA] Connecting to local Kafka brokers... ');
    await producer.connect();
    isProducerConnected = true;
    console.log('✓ Connected!\n');
  } catch (err) {
    console.error(`\n[FATAL] Cannot connect to local Kafka (${KAFKA_BROKERS.join(',')}): ${err.message}`);
    console.error('Make sure your local Kafka container is running: npm run infra:up\n');
    process.exit(1);
  }

  connectToStream();
}

function connectToStream() {
  if (isShuttingDown) return;

  const urlObj = new URL(STREAM_URL);
  const client = urlObj.protocol === 'https:' ? https : http;

  console.log(`[STREAM] Connecting to remote stream: ${STREAM_URL}...`);

  const req = client.get(
    STREAM_URL,
    {
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        console.error(`[STREAM ERROR] Remote server returned HTTP ${res.statusCode}: ${res.statusMessage}`);
        res.resume();
        scheduleReconnect(5000);
        return;
      }

      console.log('✓ Connected to remote stream! Awaiting vehicle packets...\n');

      let buffer = '';

      res.on('data', async (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep trailing incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) {
            continue; // Ignore keep-alive heartbeats and comments
          }

          if (trimmed.startsWith('data: ')) {
            const rawJson = trimmed.slice(6);
            await forwardToKafka(rawJson);
          }
        }
      });

      res.on('end', () => {
        console.log('[STREAM CLOSED] Remote server closed the connection.');
        scheduleReconnect(3000);
      });

      res.on('error', (err) => {
        console.error(`[STREAM READ ERROR] ${err.message}`);
        scheduleReconnect(3000);
      });
    }
  );

  req.on('error', (err) => {
    console.error(`[CONNECTION ERROR] Failed to connect to ${STREAM_URL}: ${err.message}`);
    scheduleReconnect(5000);
  });

  activeRequest = req;
}

async function forwardToKafka(rawJson) {
  try {
    const data = JSON.parse(rawJson);
    const imei = String(data.imei || 'unknown');
    const records = Array.isArray(data.records) ? data.records : [];
    packetCount++;

    await producer.send({
      topic: KAFKA_TOPIC,
      messages: [
        {
          key: imei,
          value: rawJson,
        },
      ],
    });

    const timeStr = new Date().toLocaleTimeString();
    const recordCount = records.length;
    let locationStr = 'No GPS records';
    if (recordCount > 0) {
      const latest = records[records.length - 1];
      locationStr = `Lat: ${latest.latitude?.toFixed(5)} Lng: ${latest.longitude?.toFixed(5)} | ${latest.speed || 0} km/h | Sat: ${latest.satellites || 0}`;
    }

    console.log(
      `[#${packetCount}] ${timeStr} 📡 IMEI: ${imei} (${recordCount} recs) → Local Kafka [${KAFKA_TOPIC}] | ${locationStr}`
    );
  } catch (err) {
    console.error(`[FORWARD ERROR] Failed to process payload: ${err.message}`);
  }
}

function scheduleReconnect(delayMs) {
  if (isShuttingDown) return;
  console.log(`[RETRY] Reconnecting in ${delayMs / 1000}s...`);
  setTimeout(connectToStream, delayMs);
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[SHUTDOWN] Stopping bridge gracefully...');

  if (activeRequest) {
    try {
      activeRequest.destroy();
    } catch (_) {}
  }

  if (isProducerConnected) {
    try {
      await producer.disconnect();
      console.log('[KAFKA] Disconnected from local Kafka.');
    } catch (_) {}
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startBridge().catch((err) => {
  console.error('[UNCAUGHT]', err);
  process.exit(1);
});
