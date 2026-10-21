# Fleet Vision — Docker & Environment Setup Guide

Comprehensive reference guide for configuring, building, and running Docker containers in **Local Development** and **Production** environments.

---

## 📌 Architecture Overview

Fleet Vision supports two primary execution topologies:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. LOCAL DEVELOPMENT (Full Stack Containerized)                             │
│                                                                             │
│  [ Docker Bridge Network: default ]                                         │
│  ┌────────────────┐     ┌──────────────┐     ┌──────────────┐               │
│  │  fv-postgres   │     │   fv-redis   │     │   fv-kafka   │               │
│  │ (Timescale+GIS)│     │  (Port 6379) │     │ (KRaft 9092) │               │
│  └────────┬───────┘     └──────┬───────┘     └──────┬───────┘               │
│           │                    │                    │                       │
│           └───────────┬────────┴────────────┬───────┘                       │
│                       ▼                     ▼                               │
│              ┌─────────────────┐   ┌──────────────────┐                     │
│              │ fv-backend-api  │   │fv-data-processor │                     │
│              │ (Next.js :3000) │   │ (Kafka Consumer) │                     │
│              └─────────────────┘   └──────────────────┘                     │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. PRODUCTION (Application Containers + Managed Cloud Infrastructure)      │
│                                                                             │
│  [ Managed Cloud / External Services ]                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐ │
│  │ AWS RDS/TimescaleDB  │  │ AWS ElastiCache/Redis│  │ AWS MSK / Kafka    │ │
│  └──────────┬───────────┘  └──────────┬───────────┘  └─────────┬──────────┘ │
│             │                         │                        │            │
│             └────────────┬────────────┴─────────────┬──────────┘            │
│                          ▼                          ▼                       │
│  [ Production Docker Stack ]                        │                       │
│  ┌─────────────────────────────────┐   ┌────────────┴───────────┐           │
│  │         fv-backend-api          │   │   fv-data-processor    │           │
│  │         (Next.js :3000)         │   │    (Worker Daemon)     │           │
│  └─────────────────────────────────┘   └────────────────────────┘           │
│                                                                             │
│  [ Native Host / EC2 Service ]                                              │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Teltonika Go TCP Server (systemd :8500 -> Kafka)            │           │
│  └──────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Environment Configuration Matrix

| Environment | Compose File | Target Services | Env File | Hostname Target |
|---|---|---|---|---|
| **Local (All Containers)** | [`docker-compose.yml`](file:///home/yash/Desktop/projects/fleet-vision/docker-compose.yml) | `postgres`, `redis`, `kafka`, `backend-api`, `data-processor` | Auto-configured inside compose | Internal Docker DNS (`postgres`, `redis`, `kafka`) |
| **Local (Hybrid Dev)** | [`docker-compose.yml`](file:///home/yash/Desktop/projects/fleet-vision/docker-compose.yml) | `postgres`, `redis`, `kafka` | [`.env`](file:///home/yash/Desktop/projects/fleet-vision/.env) | `localhost` (ports 5432, 6379, 9092) |
| **Production** | [`docker-compose.prod.yml`](file:///home/yash/Desktop/projects/fleet-vision/docker-compose.prod.yml) | `backend-api`, `data-processor` | `.env.production` (from [`.env.production.example`](file:///home/yash/Desktop/projects/fleet-vision/.env.production.example)) | External cloud hostnames / IPs |

---

## 💻 1. Local Development Workflows

### Option A: Full Docker Stack (All 5 Containers)
Recommended when you want to run the entire backend and worker stack without installing Node.js dependencies locally.

```bash
# 1. Start all 5 containers
npm run docker:local:up

# 2. Check running container status
docker compose ps

# 3. View live combined logs
npm run docker:local:logs

# 4. Stop all containers
npm run docker:local:down
```

> **Note on Initial Run**: The database schema must be initialized once after starting Postgres. Run:
> ```bash
> npm run db:push
> docker exec fv-postgres psql -U postgres -d fleet_vision -c \
>   "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT create_hypertable('\"telemetry_records\"', 'time');"
> ```

---

### Option B: Hybrid Development (Docker DBs + Local Host Apps)
Recommended during active feature coding for instant hot-reloading (Next.js HMR + TypeScript `tsx watch`).

```bash
# 1. Start only infrastructure containers
npm run infra:up

# 2. Start applications natively on host (reads root .env)
npm run dev:all

# Or in separate terminal tabs:
npm run dev:dashboard   # Next.js API & UI on http://localhost:3000
npm run dev:processor   # Kafka consumer worker
npm run dev:tcp         # Go TCP Gateway on port 8500

# 3. Stop infrastructure when finished
npm run infra:down
```

---

## 🚀 2. Production Deployment Workflow

In production, stateful databases and brokers (PostgreSQL/TimescaleDB, Redis, Kafka) typically run as managed cloud services (e.g. AWS RDS, ElastiCache, MSK) or on dedicated database servers. 

Docker runs **only** the application containers: `backend-api` and `data-processor`.

### Step 1: Create Production Environment File
Copy the provided template and insert your production endpoints:

```bash
cp .env.production.example .env.production
```

Edit `.env.production` with your credentials:
```env
# Production PostgreSQL with PostGIS & TimescaleDB
DATABASE_URL="postgresql://dbuser:StrongPassword@db-cluster.internal:5432/fleet_vision?schema=public&sslmode=require"

# Production Redis (Cluster or Single Node)
REDIS_URL="redis://:RedisPassword@redis.internal:6379"

# Production Kafka Brokers (comma-separated)
KAFKA_BROKERS="b-1.msk.internal:9092,b-2.msk.internal:9092"
KAFKA_TOPIC="telemetry-raw"
CONSUMER_GROUP="data-processor-group"

# Application Secrets
PORT=3000
JWT_SECRET="generate_at_least_32_random_characters_secret_key"
ENABLE_COLD_STORAGE=false
```

### Step 2: Build & Start Production Containers

```bash
# Build production images
npm run docker:prod:build

# Launch production containers in background
npm run docker:prod:up

# Verify containers are healthy and running
docker compose -f docker-compose.prod.yml ps

# Tail logs
npm run docker:prod:logs
```

### Step 3: Run Database Migrations in Production
Before traffic starts hitting the API, apply Prisma migrations:

```bash
npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
```

### Step 4: Stop Production Containers
```bash
npm run docker:prod:down
```

---

## 📋 Command Quick Reference

| Command | Action | Compose Target |
|---|---|---|
| `npm run docker:local:up` | Starts all 5 containers locally | `docker-compose.yml` |
| `npm run docker:local:down` | Stops all 5 local containers | `docker-compose.yml` |
| `npm run docker:local:logs` | Streams logs of all 5 local containers | `docker-compose.yml` |
| `npm run docker:local:build` | Rebuilds `backend-api` & `data-processor` images | `docker-compose.yml` |
| `npm run infra:up` | Starts only Postgres, Redis, Kafka | `docker-compose.yml` |
| `npm run infra:down` | Stops infrastructure containers | `docker-compose.yml` |
| `npm run infra:logs` | Streams logs for Postgres, Redis, Kafka | `docker-compose.yml` |
| `npm run docker:prod:up` | Starts production `backend-api` + `data-processor` | `docker-compose.prod.yml` |
| `npm run docker:prod:down` | Stops production containers | `docker-compose.prod.yml` |
| `npm run docker:prod:logs` | Streams production container logs | `docker-compose.prod.yml` |
| `npm run docker:prod:build` | Builds production Docker images | `docker-compose.prod.yml` |

---

## 🛠️ Troubleshooting & Common Scenarios

### 1. Port Conflicts (5432, 6379, 9092, 3000)
If containers fail to bind ports, verify if local services are already running on your host:
```bash
sudo lsof -i :5432   # PostgreSQL
sudo lsof -i :6379   # Redis
sudo lsof -i :9092   # Kafka
sudo lsof -i :3000   # Next.js Web Dashboard
```
Stop host-level services if they collide (e.g. `sudo systemctl stop postgresql redis-server`).

### 2. Large Initial Download / Slow Network
The local stack uses enterprise-ready images:
- `timescale/timescaledb-ha:pg15-latest` (~1.06 GB): bundles PostgreSQL, TimescaleDB, and PostGIS.
- `confluentinc/cp-kafka:7.6.0` (~450 MB): Kafka in KRaft mode.

These downloads only happen once. To pull images in the background:
```bash
docker compose pull
```

### 3. Kafka Dual Listeners Explained
[docker-compose.yml](file:///home/yash/Desktop/projects/fleet-vision/docker-compose.yml) configures two separate listeners for Kafka:
- `PLAINTEXT://localhost:9092`: Used when connecting from your **host machine** (e.g. `npm run dev:tcp` or `npm run dev:processor`).
- `INTERNAL://kafka:29092`: Used when connecting from **inside Docker containers** (e.g. `fv-data-processor`).

### 4. Cleaning Up Volumes
If you need a complete clean reset of local databases and Kafka topics:
```bash
docker compose down -v
```
*(Warning: `-v` permanently wipes local PostgreSQL data, Redis keys, and Kafka offsets).*
