# Fleet Vision Enterprise — Runbook

Quick-start guide to get the entire platform running in local development or production (EC2).

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker & Docker Compose | Latest | `docker compose version` |
| Node.js | v20+ | `node --version` |
| Go (for TCP server) | v1.20+ | `go version` |

---

## Local Development (Quick Start)

### 1. Start Infrastructure (Docker)

```bash
npm run infra:up
```

Verify all 3 infrastructure containers are healthy:

```bash
docker compose -f docker-compose.yml -f docker-compose.infra.yml ps
# Should show: fv-postgres (healthy), fv-redis (healthy), fv-kafka (healthy)
```

### 2. Install Dependencies + Push Schema

```bash
# Install dependencies
npm install

# Push Prisma schema to local database
npm run db:push

# Verify hypertable is initialized (runs automatically via init-timescaledb.sql)
docker exec fv-postgres psql -U postgres -d fleet_vision \
  -f /docker-entrypoint-initdb.d/010-init-timescaledb.sql
```

### 3. Start Services

**Option A — All services in separate terminals (recommended for development):**
```bash
# Terminal 1: Go TCP Gateway (port 8500)
npm run dev:tcp

# Terminal 2: Data Processor (Kafka consumer)
npm run dev:processor

# Terminal 3: Web Dashboard (port 3000)
npm run dev:dashboard
```

**Option B — Run entire application stack in Docker:**
```bash
npm run docker:local:up
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
# Edit credentials: RDS endpoint & password, TimescaleDB password, Redis, Kafka, JWT secrets
nano .env.production
```

#### 3. Start Production Stack
```bash
npm run docker:prod:up
```

Verify containers are running:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
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
| `npm run infra:up` | **Local**: Start TimescaleDB + Redis + Kafka |
| `npm run infra:down` | **Local**: Stop infrastructure containers |
| `npm run infra:logs` | **Local**: View infrastructure logs |
| `npm run infra:clean` | **Local**: Stop infrastructure and delete data volumes |
| `npm run docker:local:up` | **Local**: Build and start all 5 containers |
| `npm run docker:local:down` | **Local**: Stop local container stack |
| `npm run docker:local:logs` | **Local**: View logs for all local containers |
| `npm run docker:prod:up` | **Prod**: Start TimescaleDB, backend API, and data processor |
| `npm run docker:prod:down` | **Prod**: Stop production container stack |
| `npm run docker:prod:logs` | **Prod**: View production logs |
| `npm run docker:prod:build` | **Prod**: Build production Docker images |
| `npm run db:push` | Push Prisma schema to `DATABASE_URL` (RDS or local DB) |
| `npm run db:push:timescale` | Push schema to TimescaleDB on port 5433 & configure hypertable |
| `npm run db:studio` | Open visual Prisma Studio browser |
| `npm run dev` | Start dashboard + processor locally |
| `npm run dev:all` | Start dashboard, TCP server, and processor locally |

---

## Troubleshooting

| Problem | Root Cause | Fix |
|---|---|---|
| TimescaleDB fails to start on EC2 | Data directory permissions | Run `sudo chown -R 1000:1000 /opt/timescaledb/data && sudo chmod 700 /opt/timescaledb/data` |
| `fv-backend-api` unhealthy | Node health probe failing | Check logs: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs backend-api`. Verify `/api/health` returns HTTP 200. |
| Cannot connect to TimescaleDB from EC2 shell | Port collision | Container binds to host port `5433` (not `5432`). Use `psql -h localhost -p 5433 -U postgres -d fleet_vision`. |
| App containers cannot reach TimescaleDB | Docker networking | App containers connect internally to `timescaledb:5432` on bridge network `fleet-net`. Ensure both are in `docker-compose.prod.yml`. |
| "relation telemetry_records does not exist" | Schema not pushed to TimescaleDB | Run `npm run db:push:timescale` to sync tables to TimescaleDB. |
