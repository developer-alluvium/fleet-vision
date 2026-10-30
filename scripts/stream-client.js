#!/usr/bin/env node
// scripts/stream-client.js
// Connects to the remote TCP server's HTTP /stream endpoint to receive live GPS telemetry.
//
// Usage:
//   node scripts/stream-client.js <EC2_HOST_OR_IP> [PORT=8501] [FILTER_IMEI]
// Examples:
//   node scripts/stream-client.js 13.232.xxx.xxx
//   node scripts/stream-client.js localhost 8501
//   node scripts/stream-client.js 13.232.xxx.xxx 8501 864209041234567

const http = require('http');

const host = process.argv[2] || process.env.REMOTE_TCP_HOST || 'localhost';
const port = parseInt(process.argv[3] || process.env.REMOTE_TCP_PORT || '8501', 10);
const filterIMEI = process.argv[4] || process.env.FILTER_IMEI || '';

const path = filterIMEI ? `/stream?imei=${filterIMEI}` : '/stream';
const url = `http://${host}:${port}${path}`;

console.log('┌──────────────────────────────────────────────────────────┐');
console.log('│         Fleet Vision · Remote Stream Listener            │');
console.log('├──────────────────────────────────────────────────────────┤');
console.log(`│ Target URL : ${url.padEnd(44)}│`);
console.log(`│ Filter IMEI: ${(filterIMEI || 'None (All Vehicles)').padEnd(44)}│`);
console.log('└──────────────────────────────────────────────────────────┘\n');

function connect() {
  console.log(`[CONNECTING] Connecting to ${url}...`);

  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[ERROR] Server returned HTTP ${res.statusCode}: ${res.statusMessage}`);
      res.resume();
      setTimeout(connect, 3000);
      return;
    }

    console.log(`[CONNECTED] ✓ Live stream active. Waiting for vehicle telemetry...\n`);

    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete trailing chunk

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {
          continue; // Comment/heartbeat
        }

        if (trimmed.startsWith('data: ')) {
          const raw = trimmed.slice(6);
          try {
            const data = JSON.parse(raw);
            handleTelemetry(data);
          } catch (err) {
            console.log(`[RAW DATA] ${raw}`);
          }
        }
      }
    });

    res.on('end', () => {
      console.log('\n[DISCONNECTED] Stream closed by remote server. Reconnecting in 3s...');
      setTimeout(connect, 3000);
    });
  });

  req.on('error', (err) => {
    console.error(`[CONNECTION ERROR] ${err.message}. Retrying in 3s...`);
    setTimeout(connect, 3000);
  });
}

function handleTelemetry(msg) {
  const time = new Date().toLocaleTimeString();
  const count = msg.records ? msg.records.length : 0;
  console.log(`[${time}] 📡 Received packet for IMEI: ${msg.imei} (${msg.codec}, ${count} records)`);

  if (msg.records && msg.records.length > 0) {
    const latest = msg.records[msg.records.length - 1];
    console.log(`       📍 Lat: ${latest.latitude?.toFixed(6)} | Lng: ${latest.longitude?.toFixed(6)} | Speed: ${latest.speed} km/h | Sat: ${latest.satellites}`);
  }
}

connect();
