# Fleet Vision Enterprise — Runbook

Quick-start guide to get the entire platform running from scratch.

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker Desktop | Latest | `docker --version` |
| Node.js | v20+ | `node --version` |
| Go | v1.20+ | `go version` |

---

## Quick Start (5 Steps)

### 1. Start Infrastructure

```bash
npm run infra:up
```

Verify all 3 containers are healthy:

```bash
docker compose ps
# Should show: fv-postgres (healthy), fv-redis (healthy), fv-kafka (healthy)
```

### 2. Install Dependencies + Initialize Database

```bash
# Install all npm dependencies
npm install

# Push Prisma schema to database
npm run db:push

# Create TimescaleDB hypertable (one-time only)
docker exec fv-postgres psql -U postgres -d fleet_vision -c \
  "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT create_hypertable('\"telemetry_records\"', 'time');"
```

### 3. Start All Services

**Option A — Single terminal:**
```bash
npm run dev:all
```

**Option B — Separate terminals (recommended):**
```bash
# Terminal 1: Go TCP Gateway (port 8500)
npm run dev:tcp

# Terminal 2: Data Processor (Kafka consumer)
npm run dev:processor

# Terminal 3: Web Dashboard (port 3000)
npm run dev:dashboard
```

### 4. Create Organization + Register Device

```bash
# Create org
curl -X POST http://localhost:3000/api/v1/organizations \
  -H "Content-Type: application/json" \
  -d '{"name": "My Fleet", "adminEmail": "admin@myfleet.com"}'

# Note the orgId from the response, then register a device:
curl -X POST http://localhost:3000/api/v1/devices \
  -H "Content-Type: application/json" \
  -d '{"imei": "353456789012345", "orgId": "PASTE_ORG_ID"}'
```

### 5. View Data

```bash
# Open Prisma Studio (visual database browser)
npm run db:studio
# Opens at http://localhost:5555

# Query live locations
curl "http://localhost:3000/api/v1/live-locations?orgId=PASTE_ORG_ID"

# Query historical data
curl "http://localhost:3000/api/v1/history?imei=353456789012345&orgId=PASTE_ORG_ID"
```

---

## All Available Commands

| Command | Description |
|---|---|
| `npm run infra:up` | Start Docker containers (TimescaleDB + Redis + Kafka) |
| `npm run infra:down` | Stop Docker containers |
| `npm run infra:logs` | Tail container logs |
| `npm run dev` | Start dashboard + processor |
| `npm run dev:all` | Start all 3 services |
| `npm run dev:tcp` | Start Go TCP Gateway only |
| `npm run dev:processor` | Start data processor only |
| `npm run dev:dashboard` | Start Next.js dashboard only |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:push` | Push schema to database |
| `npm run db:migrate` | Run production migrations |
| `npm run db:studio` | Open Prisma Studio GUI |
| `npm run build` | Build all packages |
| `npm run lint` | Lint all packages |

---

## Stopping the Project

```bash
# Stop application services
# Press Ctrl+C in each terminal

# Stop infrastructure
npm run infra:down
```

---

## Connecting a Teltonika Device

1. Open **Teltonika Configurator**
2. Go to **GPRS → Server Settings**
3. Set **Domain:** your IP, **Port:** `8500`, **Protocol:** `TCP`
4. Save to device

> The device's IMEI must be registered via `POST /api/v1/devices` BEFORE it can send data.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Containers won't start | Check Docker is running: `docker info` |
| Port conflict | Check: `lsof -i :5432`, `lsof -i :6379`, `lsof -i :9092` |
| "Unauthorized IMEI" in processor logs | Register the device: `POST /api/v1/devices` |
| Prisma errors | Regenerate: `npm run db:generate` |
| No data appearing | Check Redis auth: `docker exec fv-redis redis-cli HGETALL "auth:YOUR_IMEI"` |
