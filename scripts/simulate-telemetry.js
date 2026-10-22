// scripts/simulate-telemetry.js
// Sends a simulated GPS telemetry packet to the Kafka topic.
// Usage: node scripts/simulate-telemetry.js [IMEI] [LAT] [LNG] [SPEED]

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env or .env.production
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

let Kafka;
try {
  Kafka = require('kafkajs').Kafka;
} catch {
  try {
    Kafka = require('../apps/data-processor/node_modules/kafkajs').Kafka;
  } catch (err) {
    console.error('kafkajs not found. Run: npm install kafkajs');
    process.exit(1);
  }
}

const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const topic = process.env.KAFKA_TOPIC || 'telemetry-raw';

const imei = process.argv[2] || '123456789012345';
const lat = parseFloat(process.argv[3]) || 28.6139; // Default: New Delhi
const lng = parseFloat(process.argv[4]) || 77.2090;
const speed = parseFloat(process.argv[5]) || 65;

async function send() {
  console.log(`[SIMULATOR] Connecting to Kafka brokers: ${brokers.join(', ')}`);
  console.log(`[SIMULATOR] Target Topic: ${topic}`);
  console.log(`[SIMULATOR] Generating packet for IMEI: ${imei}`);

  const kafka = new Kafka({
    clientId: 'telemetry-simulator',
    brokers,
    ssl: process.env.KAFKA_SSL === 'true' || brokers[0].includes('amazonaws.com:9098') || brokers[0].includes(':9094'),
  });

  const producer = kafka.producer();
  await producer.connect();
  console.log('[SIMULATOR] ✓ Producer connected to Kafka');

  const now = new Date();
  const payload = {
    imei,
    codec: '8E',
    server_timestamp: now.toISOString(),
    records: [
      {
        timestamp: now.toISOString(),
        priority: 1,
        longitude: lng,
        latitude: lat,
        altitude: 215,
        angle: 45,
        satellites: 14,
        speed,
        io_elements: {
          '239': 1,      // ignition on
          '240': 1,      // movement on
          '66': 12500,   // 12.5V external voltage
          '67': 4150,    // 4.15V internal battery
          '21': 4,       // GSM signal (0-5)
          '69': 1,       // GNSS status
          '16': 105230,  // Total Odometer
        },
      },
    ],
  };

  await producer.send({
    topic,
    messages: [
      {
        key: imei,
        value: JSON.stringify(payload),
      },
    ],
  });

  console.log(`[SIMULATOR] ✓ Successfully sent telemetry packet to "${topic}"!`);
  console.log(`  - Lat: ${lat}, Lng: ${lng}, Speed: ${speed} km/h, Ignition: ON`);

  await producer.disconnect();
}

send().catch((err) => {
  console.error('[SIMULATOR] ✗ Error publishing to Kafka:', err);
  process.exit(1);
});
