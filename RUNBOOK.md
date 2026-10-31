# Fleet Vision Enterprise — Runbook

Quick-start guide to get the entire platform running in local development or production (EC2).

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker & Docker Compose | Latest | `docker compose version` |
| Node.js | v20+ | `node --version` |
| Go (for TCP server) | v1.20+ | `go version` |

---

## Local Development

Choose the workflow that matches your development goal:

- **[Mode 1: Local Backend + Live EC2 TCP Stream](#mode-1-local-backend--live-ec2-tcp-stream-recommended-for-ui--pipeline-dev)**: Ingest real, live vehicle GPS telemetry from your remote EC2 server into your local pipeline without needing physical hardware locally.
- **[Mode 2: Full Local Stack (Local TCP Server + Local Backend)](#mode-2-full-local-stack-including-local-tcp-server)**: Completely offline/isolated development where your local machine runs its own Go TCP server for Teltonika devices or simulated telemetry.

---

### Common Setup (Prerequisites for Both Modes)

Before running either mode for the first time:

#### 1. Start Local Infrastructure
Starts TimescaleDB (PostgreSQL), Redis, and Kafka KRaft in Docker:
```bash
npm run infra:up
```

Verify all 3 containers are healthy:
```bash
docker compose -f docker-compose.yml -f docker-compose.infra.yml ps
# Should show: fv-postgres (healthy), fv-redis (healthy), fv-kafka (healthy)
```

#### 2. Install Dependencies & Initialize Database
```bash
# 1. Install Node dependencies
npm install

# 2. Push Prisma database schema to local PostgreSQL
npm run db:push

# 3. Initialize TimescaleDB hypertable for telemetry
docker exec fv-postgres psql -U postgres -d fleet_vision \
  -f /docker-entrypoint-initdb.d/010-init-timescaledb.sql

# 4. (Optional) Seed fleet vehicles & devices into DB and Redis cache
node scripts/register-fleet-devices.js
```

---

### Mode 1: Local Backend + Live EC2 TCP Stream (Recommended for UI & Pipeline Dev)

> **Use Case**: You are writing code for the **Web Dashboard** or **Data Processor** and want to see **real vehicle GPS movements on the map**. Physical GPS devices installed in vehicles are connected over TCP to your remote EC2 server. You do not have local hardware trackers.

This setup pulls live telemetry packets from the EC2 server (`https://fleetvision.alvision.in/stream`) and publishes them directly into your local Kafka broker (`telemetry-raw`).

#### How to Run:

Open **2 or 3 separate terminals**:

```bash
# Terminal 1: EC2 Stream Bridge (pulls live packets from EC2 -> pushes to local Kafka)
npm run bridge:ec2

# Terminal 2: Data Processor (consumes local Kafka, evaluates alerts, writes to TimescaleDB)
npm run dev:processor

# Terminal 3: Web Dashboard & APIs (Next.js server on http://localhost:3000)
npm run dev:dashboard
```

*(Tip: You can combine Terminals 2 & 3 into a single command using `npm run dev`, which runs the dashboard and processor concurrently)*:
```bash
# Terminal 1:
npm run bridge:ec2

# Terminal 2:
npm run dev
```

#### What You Will See:
- **Terminal 1 (`bridge:ec2`)**: Prints each incoming packet received from EC2 (`[#1] 📡 IMEI: 8622... Lat: 28.61 Lng: 77.20 → Local Kafka [telemetry-raw]`).
- **Terminal 2 (`dev:processor`)**: Logs consumed packets, geofence evaluations, and TimescaleDB batch inserts.
- **Terminal 3 (`dev:dashboard`)**: Open `http://localhost:3000` to see real-time moving markers on the map!

---

### Mode 2: Full Local Stack (Including Local TCP Server)

> **Use Case**: You are modifying the **Go TCP ingestion server**, working completely offline without an internet connection, connecting physical GPS tracker hardware to your computer's local IP (port `8500`), or testing with synthetic/mock GPS data.

You have two ways to run this:

#### Approach A: The "One-Command" Docker Stack (Runs All 6 Containers)
If you want the entire system running in Docker without managing multiple terminal windows or installing Go/Node locally:

```bash
# One single command to build and start ALL 6 services:
# (PostgreSQL/TimescaleDB, Redis, Kafka, Go TCP server, Data Processor, Next.js Web Dashboard)
npm run docker:local:up
```

**Useful Docker Management Commands:**
```bash
# View aggregated live logs across all containers
npm run docker:local:logs

# View logs for a specific service (e.g., tcp-server or data-processor)
docker compose -f docker-compose.yml -f docker-compose.infra.yml logs -f tcp-server data-processor

# Check status of all containers
docker compose -f docker-compose.yml -f docker-compose.infra.yml ps

# Stop all local containers
npm run docker:local:down
```

---

#### Approach B: Separate Terminals with Hot-Reload (Recommended for Active Coding)
When actively writing code in `apps/tcp-server`, `apps/data-processor`, or `apps/web-dashboard`, run them directly via Node and Go so changes reload instantly without rebuilding Docker images.

Make sure infrastructure is already running (`npm run infra:up`), then choose either **One Command** or **Separate Terminals**:

**Single Command (all 3 apps concurrently):**
```bash
npm run dev:all
```

**OR Separate Terminals (cleaner individual log views):**
```bash
# Terminal 1: Go TCP Gateway (listens for Teltonika tracker packets on 0.0.0.0:8500)
npm run dev:tcp

# Terminal 2: Data Processor Worker (consumes local Kafka 'telemetry-raw')
npm run dev:processor

# Terminal 3: Web Dashboard (Next.js on http://localhost:3000)
npm run dev:dashboard
```

#### Generating Test Telemetry in Mode 2:
Since you are running your own local TCP gateway, you can simulate vehicle GPS packets:
```bash
# Send a test telemetry packet directly into local Kafka:
# Usage: node scripts/simulate-telemetry.js [IMEI] [LAT] [LNG] [SPEED]
node scripts/simulate-telemetry.js 862272087994762 28.6139 77.2090 65
```

---

## Production Deployment (AWS EC2)

### Architecture
- **TimescaleDB + PostGIS**: Containerized (`fv-timescaledb`) with persistent data on EC2 at `/opt/timescaledb/data`.
- **Backend API (`fv-backend-api`) & Data Processor (`fv-data-processor`)**: Containerized on the shared `fleet-net` Docker bridge network.
- **Relational PostgreSQL (RDS)**: External AWS RDS instance.
- **Redis & Kafka**: External managed services (AWS ElastiCache, AWS MSK / cluster).

### Step-by-Step EC2 Setup

#### 1. Prepare Host TimescaleDB Storage
```bash
sudo mkdir -p /opt/timescaledb/data
# Set ownership to container postgres user (UID 1000)
sudo chown -R 1000:1000 /opt/timescaledb/data
sudo chmod 700 /opt/timescaledb/data
```

#### 2. Configure Production Environment
```bash
cp .env.production.example .env.production
nano .env.production   # Fill in RDS, TimescaleDB, Redis, Kafka, and JWT values

# Recommended: Also copy or symlink to .env so raw docker compose commands work without extra flags
cp .env.production .env
```

#### 3. Start Production Stack
```bash
# Uses npm script (includes --env-file .env.production automatically):
npm run docker:prod:up

# Or raw docker compose command:
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Verify containers are running:
```bash
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml ps
# Should show:
#   fv-timescaledb (healthy) - 0.0.0.0:5433->5432/tcp
#   fv-backend-api (healthy) - 0.0.0.0:3000->3000/tcp
#   fv-data-processor (running)
```

#### 4. Run Migrations & Initialize TimescaleDB Hypertables

```bash
# a) Push relational tables to AWS RDS
npm run db:push

# b) Push telemetry tables to TimescaleDB & convert to hypertable
npm run db:push:timescale
```

Verify hypertable status:
```bash
docker exec fv-timescaledb psql -U postgres -d fleet_vision \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
# Expected output: telemetry_records
```

#### 5. Restart Application Containers
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart backend-api data-processor
```

---

## All Available NPM Scripts

| Command | Description |
|---|---|
| `npm run bridge:ec2` | **Bridge**: Pulls live vehicle GPS stream from EC2 and pushes to local Kafka |
| `npm run stream:listen` | **Debug**: CLI tool to inspect the live SSE telemetry stream directly in terminal |
| `npm run dev:all` | **Local**: Starts dashboard, TCP server, and data processor concurrently |
| `npm run dev` | **Local**: Starts dashboard and data processor concurrently (for use with `bridge:ec2`) |
| `npm run dev:tcp` | **Local**: Starts Go TCP ingestion server standalone (port 8500) |
| `npm run dev:processor` | **Local**: Starts Kafka data processor worker standalone |
| `npm run dev:dashboard` | **Local**: Starts Next.js web dashboard standalone (port 3000) |
| `npm run infra:up` | **Local**: Starts infrastructure containers (TimescaleDB + Redis + Kafka) |
| `npm run infra:down` | **Local**: Stops infrastructure containers |
| `npm run infra:logs` | **Local**: Views infrastructure logs |
| `npm run infra:clean` | **Local**: Stops infrastructure and deletes data volumes |
| `npm run docker:local:up` | **Local (All-In-One)**: Builds and starts all 6 Docker containers |
| `npm run docker:local:down` | **Local (All-In-One)**: Stops the local Docker container stack |
| `npm run docker:local:logs` | **Local (All-In-One)**: Views logs for all local Docker containers |
| `npm run docker:prod:up` | **Prod**: Starts TimescaleDB, backend API, and data processor |
| `npm run docker:prod:down` | **Prod**: Stops production container stack |
| `npm run docker:prod:logs` | **Prod**: Views production logs |
| `npm run docker:prod:build` | **Prod**: Builds production Docker images |
| `npm run db:push` | Pushes Prisma schema to `DATABASE_URL` (RDS or local DB) |
| `npm run db:push:timescale` | Pushes schema to TimescaleDB on port 5433 & configures hypertable |
| `npm run db:studio` | Opens visual Prisma Studio browser |

---

## Troubleshooting

| Problem | Root Cause | Fix |
|---|---|---|
| TimescaleDB fails to start on EC2 | Data directory permissions | Run `sudo chown -R 1000:1000 /opt/timescaledb/data && sudo chmod 700 /opt/timescaledb/data` |
| `fv-backend-api` unhealthy | Node health probe failing | Check logs: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backend-api`. Verify `/api/health` returns HTTP 200. |
| Cannot connect to TimescaleDB from EC2 shell | Port collision | Container binds to host port `5433` (not `5432`). Use `psql -h localhost -p 5433 -U postgres -d fleet_vision`. |
| App containers cannot reach TimescaleDB | Docker networking | App containers connect internally to `timescaledb:5432` on bridge network `fleet-net`. Ensure both are in `docker-compose.prod.yml`. |
| "relation telemetry_records does not exist" | Schema not pushed to TimescaleDB | Run `npm run db:push:timescale` to sync tables to TimescaleDB. |
