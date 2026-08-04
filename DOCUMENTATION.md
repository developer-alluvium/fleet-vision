# Fleet Vision Enterprise — Complete Documentation

> **Fleet Vision** is a **multi-tenant, BYOD (Bring Your Own Device) telematics backend** that receives GPS telemetry from **Teltonika** tracking devices installed in vehicles, authenticates them against tenant organizations, processes the data through a high-throughput pipeline, and serves real-time + historical fleet data via REST APIs.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Tech Stack](#3-tech-stack)
4. [Prerequisites](#4-prerequisites)
5. [All Commands Reference](#5-all-commands-reference)
6. [Step-by-Step: Running the Project](#6-step-by-step-running-the-project)
7. [Standard User Flow (How It All Works Together)](#7-standard-user-flow)
8. [API Documentation](#8-api-documentation)
9. [API Testing & Documentation Tools](#9-api-testing--documentation-tools)
10. [Database Schema](#10-database-schema)
11. [Redis Data Structures](#11-redis-data-structures)
12. [Background Workers](#12-background-workers)
13. [Connecting a Teltonika Device](#13-connecting-a-teltonika-device)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        FLEET VISION ENTERPRISE                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌──────────┐    TCP/AVL     ┌──────────────┐    JSON     ┌─────────┐ │
│   │ Teltonika ├──────────────►│  TCP Gateway  ├───────────►│  Kafka  │ │
│   │  Device   │   Port 8500   │    (Go)       │            │ (KRaft) │ │
│   └──────────┘                └──────────────┘            └────┬────┘ │
│                                                                 │      │
│                                                          eachBatch     │
│                                                                 ▼      │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │                    DATA PROCESSOR (Node.js)                      │ │
│   │                                                                  │ │
│   │  1. Read IMEI from message                                       │ │
│   │  2. Query Redis: HGETALL auth:{imei}                            │ │
│   │  3. If unauthorized → DROP packet                                │ │
│   │  4. Inject orgId from Redis into each record                    │ │
│   │  5. Update Redis Live Map: HSET live_map:org:{orgId}            │ │
│   │  6. Bulk INSERT into TimescaleDB                                │ │
│   └──────────┬───────────────────────────────────┬──────────────────┘ │
│              │                                   │                     │
│              ▼                                   ▼                     │
│   ┌──────────────────┐                ┌──────────────────┐            │
│   │      Redis       │                │   TimescaleDB    │            │
│   │  • auth:{imei}   │                │   + PostGIS      │            │
│   │  • live_map:org  │                │   (Hypertable)   │            │
│   └────────┬─────────┘                └────────┬─────────┘            │
│            │                                   │                       │
│            ▼                                   ▼                       │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │                  WEB DASHBOARD APIs (Next.js)                    │ │
│   │                                                                  │ │
│   │  Control Plane:                  Data Plane:                     │ │
│   │  • POST /api/v1/organizations    • GET /api/v1/live-locations    │ │
│   │  • POST /api/v1/devices          • GET /api/v1/history          │ │
│   │  • GET  /api/v1/organizations                                    │ │
│   │  • GET  /api/v1/devices                                          │ │
│   └──────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│   Background Workers:                                                   │
│   • Geofence Worker (PostGIS spatial queries)                          │
│   • Subscription Enforcer (nightly — suspend expired orgs)             │
│   • Cold Storage Archival (nightly — archive >6mo data to CSV)         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Project Structure

```
fleet-vision/
├── docker-compose.yml          # Infrastructure: TimescaleDB, Redis, Kafka
├── .env                        # Environment variables (all services read from here)
├── .env.example                # Template for .env
├── package.json                # Root workspace config (npm workspaces + Turborepo)
├── turbo.json                  # Turborepo pipeline configuration
│
├── packages/
│   └── db/                     # Shared database + Redis package (@fleet-vision/db)
│       ├── prisma/
│       │   └── schema.prisma   # Database schema (6 models, PostGIS, Hypertable)
│       ├── src/
│       │   ├── index.ts        # Prisma client singleton + re-exports
│       │   └── redis.ts        # Redis client singleton + auth/live-map helpers
│       ├── package.json
│       └── tsconfig.json
│
├── apps/
│   ├── tcp-server/             # Go TCP Gateway (port 8500)
│   │   ├── main.go             # Entry point — TCP listener + graceful shutdown
│   │   ├── handler.go          # IMEI handshake + AVL packet parsing + Kafka publish
│   │   ├── producer.go         # Kafka producer wrapper (kafka-go)
│   │   ├── parser/
│   │   │   ├── codec8.go       # Teltonika Codec 8/8E binary parser
│   │   │   ├── codec8_test.go  # Parser unit tests
│   │   │   └── types.go        # AVL data types
│   │   ├── go.mod / go.sum
│   │   └── package.json        # npm wrapper (for monorepo dev script)
│   │
│   ├── data-processor/         # Node.js Kafka Consumer + Background Workers
│   │   ├── src/
│   │   │   ├── index.ts        # Entry point — DB/Redis/Kafka init + shutdown
│   │   │   ├── consumer.ts     # Kafka consumer (eachBatch mode)
│   │   │   ├── processor.ts    # Multi-tenant telemetry processor
│   │   │   └── workers/
│   │   │       ├── geofence-worker.ts        # PostGIS spatial alert checks
│   │   │       ├── subscription-enforcer.ts  # Nightly subscription check
│   │   │       └── cold-storage.ts           # Archive old data to CSV
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web-dashboard/          # Next.js App Router (API Routes + Frontend)
│       ├── src/app/
│       │   ├── api/v1/
│       │   │   ├── organizations/route.ts    # POST + GET organizations
│       │   │   ├── devices/route.ts          # POST + GET devices
│       │   │   ├── live-locations/route.ts   # GET live fleet map (Redis)
│       │   │   └── history/route.ts          # GET historical telemetry (TimescaleDB)
│       │   ├── page.tsx        # Dashboard home page
│       │   ├── layout.tsx      # Root layout
│       │   └── globals.css     # Global styles
│       ├── next.config.mjs
│       ├── package.json
│       └── tsconfig.json
```

---

## 3. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Database** | TimescaleDB (PostgreSQL 15) | Time-series telemetry storage with hypertable partitioning |
| **Spatial** | PostGIS | Geofence polygon storage + spatial queries (ST_Contains) |
| **Cache** | Redis | Device auth cache (O(1) IMEI lookup) + Live Map |
| **Message Queue** | Apache Kafka (KRaft mode) | Decouple TCP ingestion from processing |
| **TCP Gateway** | Go | High-performance binary protocol parsing (Teltonika Codec 8) |
| **Data Processor** | Node.js + TypeScript | Kafka consumer, Redis auth, bulk DB inserts |
| **API Server** | Next.js 15 (App Router) | REST API routes + future web dashboard |
| **ORM** | Prisma 6 | Type-safe database access |
| **Monorepo** | npm Workspaces + Turborepo | Shared packages, unified scripts |

---

## 4. Prerequisites

Before starting, ensure you have installed:

| Tool | Minimum Version | Check Command |
|---|---|---|
| **Docker Desktop** | Latest | `docker --version` |
| **Node.js** | v20+ | `node --version` |
| **npm** | v10+ | `npm --version` |
| **Go** | v1.20+ | `go version` |

---

## 5. All Commands Reference

### Infrastructure Commands

| Command | Description |
|---|---|
| `npm run infra:up` | Start all Docker containers (TimescaleDB, Redis, Kafka) |
| `npm run infra:down` | Stop all Docker containers |
| `npm run infra:logs` | Tail logs from all containers |
| `docker compose ps` | Check container health status |

### Database Commands

| Command | Description |
|---|---|
| `npm run db:generate` | Generate Prisma client from schema |
| `npm run db:push` | Push schema to database (dev — no migration files) |
| `npm run db:migrate` | Run Prisma migrations (production-style) |
| `npm run db:studio` | Open Prisma Studio (visual DB browser at http://localhost:5555) |

### Application Commands

| Command | Description |
|---|---|
| `npm run dev` | Start web-dashboard + data-processor |
| `npm run dev:all` | Start ALL services (dashboard + TCP server + processor) |
| `npm run dev:dashboard` | Start only the Next.js web dashboard (http://localhost:3000) |
| `npm run dev:processor` | Start only the data processor worker |
| `npm run dev:tcp` | Start only the Go TCP gateway |
| `npm run build` | Build all packages (Turborepo) |
| `npm run lint` | Lint all packages |

### TimescaleDB Hypertable (One-time Setup)

After pushing the schema for the first time, run this to convert `telemetry_records` to a hypertable:

```bash
docker exec fv-postgres psql -U postgres -d fleet_vision -c \
  "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT create_hypertable('\"telemetry_records\"', 'time');"
```

### Redis CLI

```bash
# Connect to Redis
docker exec -it fv-redis redis-cli

# Check a device's auth status
HGETALL auth:123456789012345

# Check live map for an org
HGETALL live_map:org:<orgId>

# List all auth keys
KEYS auth:*
```

### PostgreSQL CLI

```bash
# Connect to database
docker exec -it fv-postgres psql -U postgres -d fleet_vision

# List all tables
\dt+

# Count telemetry records
SELECT COUNT(*) FROM telemetry_records;

# Check hypertable info
SELECT * FROM timescaledb_information.hypertables;
```

---

## 6. Step-by-Step: Running the Project

### Step 1 — Start Docker

Make sure Docker Desktop is running, then start all infrastructure:

```bash
npm run infra:up
```

Verify all 3 containers are healthy:

```bash
docker compose ps
```

You should see `fv-postgres`, `fv-redis`, and `fv-kafka` all with status `(healthy)`.

### Step 2 — Initialize the Database

Push the Prisma schema and create the TimescaleDB hypertable:

```bash
# Push schema to database
npm run db:push

# Create the TimescaleDB hypertable (one-time only)
docker exec fv-postgres psql -U postgres -d fleet_vision -c \
  "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT create_hypertable('\"telemetry_records\"', 'time');"
```

### Step 3 — Install Dependencies

```bash
npm install
```

### Step 4 — Start the Application

**Option A — All services in one terminal:**

```bash
npm run dev:all
```

**Option B — Each service in a separate terminal (recommended for reading logs):**

```bash
# Terminal 1: TCP Gateway
npm run dev:tcp

# Terminal 2: Data Processor
npm run dev:processor

# Terminal 3: Web Dashboard
npm run dev:dashboard
```

### Step 5 — Provision Your First Organization & Device

Use the Control Plane APIs (see Section 8 below) to create an organization and register your devices.

### Step 6 — View Data

```bash
# Open Prisma Studio (visual database browser)
npm run db:studio
```

Opens at http://localhost:5555

### Stopping Everything

```bash
# Stop application services: Ctrl+C in each terminal

# Stop infrastructure
npm run infra:down
```

---

## 7. Standard User Flow

This section explains the **end-to-end usage flow** from the perspective of a fleet operator/admin.

### Flow Diagram

```
ADMIN USER                                    SYSTEM
    │                                            │
    │  1. Create Organization                    │
    ├───────────────────────────────────────────►│
    │     POST /api/v1/organizations             │
    │     { name, adminEmail }                   │
    │                                            │
    │  ◄── Returns: orgId, userId ──────────────┤
    │                                            │
    │  2. Register Device(s)                     │
    ├───────────────────────────────────────────►│
    │     POST /api/v1/devices                   │
    │     { imei: "353...", orgId }              │
    │                                            │
    │     ┌──────────────────────────────────┐   │
    │     │ SYSTEM: Creates device in DB     │   │
    │     │ SYSTEM: Writes auth:{imei} to    │   │
    │     │         Redis with orgId         │   │
    │     └──────────────────────────────────┘   │
    │                                            │
    │  3. Configure Physical Device              │
    │     (Teltonika Configurator)                │
    │     Set server IP + port 8500              │
    │                                            │
    │  ═══════════ DATA STARTS FLOWING ══════════│
    │                                            │
    │  Device → TCP Server → Kafka → Processor   │
    │  Processor checks Redis auth → ✓ Valid     │
    │  Processor injects orgId into data         │
    │  Processor updates Redis Live Map          │
    │  Processor bulk-inserts into TimescaleDB   │
    │                                            │
    │  4. View Live Fleet Map                    │
    ├───────────────────────────────────────────►│
    │     GET /api/v1/live-locations?orgId=xxx   │
    │                                            │
    │  ◄── Returns: all devices with             │
    │      lat/lon/speed/ignition (from Redis)   │
    │                                            │
    │  5. View Historical Trip Data              │
    ├───────────────────────────────────────────►│
    │     GET /api/v1/history?imei=353...        │
    │         &orgId=xxx                         │
    │         &start=2026-01-01                  │
    │         &end=2026-01-31                    │
    │                                            │
    │  ◄── Returns: time-series telemetry data   │
    │      (from TimescaleDB)                    │
    │                                            │
```

### Step-by-Step Breakdown

#### Step 1: Create Your Organization

An admin creates their fleet organization. This is the **tenant** — all data is isolated per organization.

```bash
curl -X POST http://localhost:3000/api/v1/organizations \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ABC Transport Co.",
    "adminEmail": "admin@abctransport.com"
  }'
```

**Response:**
```json
{
  "organization": {
    "id": "cm5xyz...",
    "name": "ABC Transport Co.",
    "status": "ACTIVE",
    "subscriptionPlan": "TRIAL",
    "createdAt": "2026-08-01T12:00:00.000Z"
  },
  "user": {
    "id": "cm5abc...",
    "email": "admin@abctransport.com",
    "role": "ADMIN",
    "organizationId": "cm5xyz..."
  }
}
```

> **Save the `organization.id`** — you'll need it for all subsequent calls.

#### Step 2: Register Your GPS Devices

For each Teltonika device you want to track, register its IMEI:

```bash
curl -X POST http://localhost:3000/api/v1/devices \
  -H "Content-Type: application/json" \
  -d '{
    "imei": "353456789012345",
    "orgId": "cm5xyz..."
  }'
```

**What happens behind the scenes:**
1. Device record created in PostgreSQL
2. **Redis auth cache updated:** `HSET auth:353456789012345 isAuthorized true orgId cm5xyz...`
3. The TCP server + data processor will now **accept** data from this IMEI

#### Step 3: Configure the Physical Device

Using **Teltonika Configurator** software:
1. Connect your FMC130/FMB920 device via USB
2. Go to **GPRS → Server Settings**
3. Set **Domain:** your server IP, **Port:** `8500`, **Protocol:** `TCP`
4. Save to device

Once configured, the device will start sending GPS data automatically.

#### Step 4: View Live Fleet Locations

```bash
curl "http://localhost:3000/api/v1/live-locations?orgId=cm5xyz..."
```

**Response (from Redis — instant):**
```json
{
  "orgId": "cm5xyz...",
  "deviceCount": 2,
  "devices": {
    "353456789012345": {
      "imei": "353456789012345",
      "latitude": 28.6139,
      "longitude": 77.2090,
      "speed": 45.5,
      "ignition": true,
      "timestamp": "2026-08-01T12:30:00.000Z",
      "updatedAt": "2026-08-01T12:30:01.123Z"
    },
    "353456789012346": {
      "imei": "353456789012346",
      "latitude": 19.0760,
      "longitude": 72.8777,
      "speed": 0,
      "ignition": false,
      "timestamp": "2026-08-01T12:28:00.000Z",
      "updatedAt": "2026-08-01T12:28:01.456Z"
    }
  }
}
```

#### Step 5: View Historical Trip Data

```bash
curl "http://localhost:3000/api/v1/history?imei=353456789012345&orgId=cm5xyz...&start=2026-08-01T00:00:00Z&end=2026-08-01T23:59:59Z"
```

**Response (from TimescaleDB):**
```json
{
  "imei": "353456789012345",
  "orgId": "cm5xyz...",
  "count": 1440,
  "timeRange": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-08-01T23:59:59.000Z"
  },
  "records": [
    {
      "id": "cm5rec...",
      "time": "2026-08-01T12:30:00.000Z",
      "imei": "353456789012345",
      "organizationId": "cm5xyz...",
      "latitude": 28.6139,
      "longitude": 77.2090,
      "speed": 45.5,
      "ignition": true,
      "ioElements": { "239": 1, "240": 0, "21": 3 }
    }
  ]
}
```

---

## 8. API Documentation

### Base URL

```
http://localhost:3000/api/v1
```

---

### 8.1 Control Plane APIs (Provisioning)

These APIs are used by administrators to set up organizations and register devices.

---

#### `POST /api/v1/organizations`

Creates a new tenant organization with an admin user.

**Request:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Organization name |
| `adminEmail` | string | ✅ | Email of the initial admin user |

**Request Body:**
```json
{
  "name": "ABC Transport Co.",
  "adminEmail": "admin@abctransport.com"
}
```

**Success Response:** `201 Created`
```json
{
  "organization": {
    "id": "cm5xyz...",
    "name": "ABC Transport Co.",
    "status": "ACTIVE",
    "subscriptionPlan": "TRIAL",
    "subscriptionEndDate": null,
    "stripeCustomerId": null,
    "createdAt": "2026-08-01T12:00:00.000Z",
    "updatedAt": "2026-08-01T12:00:00.000Z"
  },
  "user": {
    "id": "cm5abc...",
    "email": "admin@abctransport.com",
    "role": "ADMIN",
    "organizationId": "cm5xyz...",
    "createdAt": "2026-08-01T12:00:00.000Z",
    "updatedAt": "2026-08-01T12:00:00.000Z"
  }
}
```

**Error Responses:**

| Status | Condition | Body |
|---|---|---|
| `400` | Missing or invalid `name` | `{ "error": "name is required and must be a non-empty string" }` |
| `400` | Missing or invalid `adminEmail` | `{ "error": "adminEmail is required and must be a valid email" }` |
| `409` | Email already exists | `{ "error": "A user with this email already exists" }` |
| `500` | Server error | `{ "error": "Internal server error" }` |

---

#### `GET /api/v1/organizations`

Lists all organizations with device/user/vehicle counts.

**Request:** No parameters required.

**Success Response:** `200 OK`
```json
{
  "organizations": [
    {
      "id": "cm5xyz...",
      "name": "ABC Transport Co.",
      "status": "ACTIVE",
      "subscriptionPlan": "TRIAL",
      "createdAt": "2026-08-01T12:00:00.000Z",
      "_count": {
        "users": 1,
        "devices": 5,
        "vehicles": 3
      }
    }
  ]
}
```

---

#### `POST /api/v1/devices`

Registers a new GPS device and authorizes it in the Redis auth cache.

**Request:**

| Field | Type | Required | Description |
|---|---|---|---|
| `imei` | string | ✅ | 15-digit IMEI number of the device |
| `orgId` | string | ✅ | Organization ID to register the device under |

**Request Body:**
```json
{
  "imei": "353456789012345",
  "orgId": "cm5xyz..."
}
```

**Success Response:** `201 Created`
```json
{
  "device": {
    "id": "cm5dev...",
    "imei": "353456789012345",
    "status": "PENDING_CONNECTION",
    "organizationId": "cm5xyz...",
    "createdAt": "2026-08-01T12:00:00.000Z",
    "updatedAt": "2026-08-01T12:00:00.000Z"
  }
}
```

**Side Effect:** Writes to Redis: `HSET auth:353456789012345 isAuthorized true orgId cm5xyz...`

**Error Responses:**

| Status | Condition | Body |
|---|---|---|
| `400` | Invalid IMEI (not 15 digits) | `{ "error": "imei must contain exactly 15 digits" }` |
| `400` | Missing orgId | `{ "error": "orgId is required" }` |
| `403` | Org is suspended/cancelled | `{ "error": "Organization is not active" }` |
| `404` | Org not found | `{ "error": "Organization not found" }` |
| `409` | IMEI already registered | `{ "error": "A device with this IMEI is already registered" }` |
| `500` | Server error | `{ "error": "Internal server error" }` |

---

#### `GET /api/v1/devices?orgId=xxx`

Lists all devices for an organization.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `orgId` | string | ✅ | Organization ID |

**Success Response:** `200 OK`
```json
{
  "devices": [
    {
      "id": "cm5dev...",
      "imei": "353456789012345",
      "status": "PENDING_CONNECTION",
      "organizationId": "cm5xyz...",
      "createdAt": "2026-08-01T12:00:00.000Z",
      "vehicle": null
    }
  ]
}
```

---

### 8.2 Data Plane APIs (Consumption)

These APIs are used by dashboard UIs and client applications to view fleet data.

---

#### `GET /api/v1/live-locations?orgId=xxx`

Returns real-time locations for all devices in an organization. **Reads from Redis only — O(1) response time.**

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `orgId` | string | ✅ | Organization ID |

**Success Response:** `200 OK`
```json
{
  "orgId": "cm5xyz...",
  "deviceCount": 2,
  "devices": {
    "353456789012345": {
      "imei": "353456789012345",
      "latitude": 28.6139,
      "longitude": 77.2090,
      "speed": 45.5,
      "ignition": true,
      "timestamp": "2026-08-01T12:30:00.000Z",
      "updatedAt": "2026-08-01T12:30:01.123Z"
    }
  }
}
```

> **Note:** This endpoint returns an empty `devices` object `{}` if no telemetry data has been received yet. Devices must be registered AND actively sending data to appear here.

**Error Responses:**

| Status | Condition | Body |
|---|---|---|
| `400` | Missing orgId | `{ "error": "orgId query parameter is required" }` |
| `500` | Server error | `{ "error": "Internal server error" }` |

---

#### `GET /api/v1/history`

Returns historical telemetry records from TimescaleDB. Enforces strict tenant isolation.

**Query Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `imei` | string | ✅ | Device IMEI to query |
| `orgId` | string | ✅ | Organization ID (for tenant isolation) |
| `start` | ISO 8601 date | ❌ | Start of time range (default: 24 hours ago) |
| `end` | ISO 8601 date | ❌ | End of time range (default: now) |

**Example:**
```
GET /api/v1/history?imei=353456789012345&orgId=cm5xyz...&start=2026-08-01T00:00:00Z&end=2026-08-01T23:59:59Z
```

**Success Response:** `200 OK`
```json
{
  "imei": "353456789012345",
  "orgId": "cm5xyz...",
  "count": 48,
  "timeRange": {
    "start": "2026-08-01T00:00:00.000Z",
    "end": "2026-08-01T23:59:59.000Z"
  },
  "records": [
    {
      "id": "cm5rec...",
      "time": "2026-08-01T12:30:00.000Z",
      "imei": "353456789012345",
      "organizationId": "cm5xyz...",
      "latitude": 28.6139,
      "longitude": 77.2090,
      "speed": 45.5,
      "ignition": true,
      "ioElements": {
        "239": 1,
        "240": 0,
        "21": 3
      }
    }
  ]
}
```

**Error Responses:**

| Status | Condition | Body |
|---|---|---|
| `400` | Missing imei | `{ "error": "imei query parameter is required" }` |
| `400` | Missing orgId | `{ "error": "orgId query parameter is required" }` |
| `400` | Invalid date format | `{ "error": "start must be a valid ISO 8601 date" }` |
| `500` | Server error | `{ "error": "Internal server error" }` |

> **Security:** The query always includes `WHERE organizationId = orgId`. Organization A **cannot** query Organization B's data even if they know the IMEI.

---

## 9. API Testing & Documentation Tools

### Recommended: Bruno (Free, Open Source)

**Bruno** is the recommended tool for both API testing and documentation. It is:
- ✅ **Free and open source** (no account needed)
- ✅ **Offline-first** — collections are stored as files in your project (git-friendly)
- ✅ **Lightweight** — no cloud sync, no telemetry
- ✅ **Import from Postman/Insomnia** if you're migrating

**Install:**
```bash
# Ubuntu/Debian
sudo apt install bruno

# Or download from: https://www.usebruno.com/downloads
```

**Usage:**
1. Open Bruno
2. Create a new collection (e.g., `Fleet Vision API`)
3. Create folders: `Control Plane`, `Data Plane`
4. Add requests for each API endpoint (see Section 8)
5. Set the base URL to `http://localhost:3000`
6. Save the collection inside your project (e.g., `fleet-vision/bruno/`)

---

### Alternative: Postman (if you prefer a GUI)

1. Download from https://www.postman.com/downloads/
2. Create a new Collection called **Fleet Vision API**
3. Set a collection variable: `baseUrl = http://localhost:3000`
4. Add requests for each endpoint
5. **Export** the collection as a JSON file and commit it to your repo

---

### Alternative: curl (Command Line)

All API examples in this doc use curl. Here's a quick reference:

```bash
# Create org
curl -X POST http://localhost:3000/api/v1/organizations \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Org", "adminEmail": "admin@test.com"}'

# Register device
curl -X POST http://localhost:3000/api/v1/devices \
  -H "Content-Type: application/json" \
  -d '{"imei": "353456789012345", "orgId": "PASTE_ORG_ID_HERE"}'

# List orgs
curl http://localhost:3000/api/v1/organizations

# List devices
curl "http://localhost:3000/api/v1/devices?orgId=PASTE_ORG_ID_HERE"

# Live locations
curl "http://localhost:3000/api/v1/live-locations?orgId=PASTE_ORG_ID_HERE"

# History
curl "http://localhost:3000/api/v1/history?imei=353456789012345&orgId=PASTE_ORG_ID_HERE"
```

---

### For API Documentation Generation

| Tool | Type | Best For |
|---|---|---|
| **Bruno** | Desktop app | Testing + git-versioned collections |
| **Swagger/OpenAPI** | Spec file | Auto-generated interactive docs |
| **Postman** | Desktop/Cloud | Team collaboration + mock servers |
| **Hoppscotch** | Web-based | Quick browser testing (https://hoppscotch.io) |

---

## 10. Database Schema

### Entity Relationship Diagram

```
┌──────────────────┐
│   Organization   │
├──────────────────┤       ┌────────────┐
│ id (PK)          │──────►│    User    │
│ name             │  1:N  ├────────────┤
│ status           │       │ id (PK)    │
│ subscriptionPlan │       │ email (UQ) │
│ subscriptionEnd  │       │ role       │
│ stripeCustomerId │       │ orgId (FK) │
│ createdAt        │       └────────────┘
│ updatedAt        │
└──────┬───────────┘
       │
       ├──── 1:N ──►┌────────────┐        ┌────────────┐
       │            │   Device   │  1:1   │  Vehicle   │
       │            ├────────────┤◄──────►├────────────┤
       │            │ id (PK)    │        │ id (PK)    │
       │            │ imei (UQ)  │        │ plateNo(UQ)│
       │            │ status     │        │ maxFuel    │
       │            │ orgId (FK) │        │ deviceId   │
       │            └────────────┘        │ orgId (FK) │
       │                                  └────────────┘
       │
       ├──── 1:N ──►┌────────────────┐
       │            │   Geofence     │
       │            ├────────────────┤
       │            │ id (PK)        │
       │            │ name           │
       │            │ polygon (GiST) │  ← PostGIS geometry(Polygon, 4326)
       │            │ orgId (FK)     │
       │            └────────────────┘
       │
       └──── (via orgId) ──►┌─────────────────────┐
                            │  TelemetryRecord    │  ← TimescaleDB Hypertable
                            ├─────────────────────┤
                            │ id + time (PK)      │  ← Composite PK for hypertable
                            │ imei                │
                            │ organizationId      │
                            │ latitude, longitude │
                            │ speed, ignition     │
                            │ ioElements (JSONB)  │
                            └─────────────────────┘
```

### Key Design Decisions

- **TelemetryRecord uses composite PK `(id, time)`** — TimescaleDB requires the partitioning column (`time`) in all unique constraints
- **Geofence uses `Unsupported("geometry(Polygon, 4326)")`** — PostGIS type managed outside Prisma
- **No foreign key** from TelemetryRecord → Device — intentional for hypertable write performance
- **`organizationId` on TelemetryRecord** — denormalized from Redis at processing time for query performance

---

## 11. Redis Data Structures

### Auth Cache — `auth:{imei}`

**Type:** Hash  
**Purpose:** O(1) device authentication during telemetry processing  
**Set by:** `POST /api/v1/devices` route  
**Read by:** Data processor (every Kafka message)

```
KEY: auth:353456789012345
FIELDS:
  isAuthorized = "true"
  orgId = "cm5xyz..."
```

### Live Map — `live_map:org:{orgId}`

**Type:** Hash  
**Purpose:** Real-time device locations for instant fleet map queries  
**Set by:** Data processor (after processing each batch)  
**Read by:** `GET /api/v1/live-locations` route

```
KEY: live_map:org:cm5xyz...
FIELDS:
  353456789012345 = '{"imei":"353456789012345","latitude":28.61,"longitude":77.20,"speed":45.5,"ignition":true,"timestamp":"...","updatedAt":"..."}'
  353456789012346 = '{"imei":"353456789012346","latitude":19.07,"longitude":72.87,"speed":0,"ignition":false,...}'
```

---

## 12. Background Workers

### Geofence Worker

**Location:** `apps/data-processor/src/workers/geofence-worker.ts`  
**Trigger:** After each telemetry batch is processed  
**What it does:** Runs a raw PostGIS `ST_Contains` query to check if any device's new coordinates fall inside a geofence polygon for its organization. Logs alerts.

### Subscription Enforcer

**Location:** `apps/data-processor/src/workers/subscription-enforcer.ts`  
**Trigger:** Nightly cron  
**What it does:**
1. Finds orgs where `subscriptionEndDate < NOW()` and `status = ACTIVE`
2. Sets status to `SUSPENDED`
3. Deletes all `auth:{imei}` entries for that org's devices from Redis → data processor will drop their future packets

### Cold Storage Archival

**Location:** `apps/data-processor/src/workers/cold-storage.ts`  
**Trigger:** Nightly cron  
**What it does:**
1. Exports `telemetry_records` older than 6 months to compressed `.csv.gz` files
2. Uploads to AWS S3 (currently stubbed — saves to local `archives/` directory)
3. Deletes archived rows from TimescaleDB to reclaim storage

---

## 13. Connecting a Teltonika Device

### Supported Devices

Any Teltonika device that uses **Codec 8 / Codec 8 Extended** protocol:
- FMC130
- FMB920
- FMB140
- FMC640
- And others in the Teltonika lineup

### Configuration Steps

1. **Connect** the device to your computer via USB
2. Open **Teltonika Configurator** software
3. Navigate to **GPRS → Server Settings**
4. Configure:
   - **Domain:** Your server's IP address (e.g., `192.168.1.50` for local, or public IP/domain for production)
   - **Port:** `8500`
   - **Protocol:** `TCP`
5. Click **Save to device**

> **Important:** If the device uses mobile data (SIM card), your server must be reachable from the internet. For local testing, the device and server must be on the same network.

### What Happens After Connection

1. Device opens TCP connection to port 8500
2. Device sends IMEI handshake → Server validates format → replies `0x01`
3. Device sends binary AVL packets → Server parses → publishes JSON to Kafka
4. Data processor reads from Kafka → checks Redis auth → processes + stores data
5. Data appears in the Live Map and History APIs

---

## 14. Troubleshooting

### Containers Won't Start

```bash
# Check Docker is running
docker info

# Check for port conflicts
lsof -i :5432   # PostgreSQL
lsof -i :6379   # Redis
lsof -i :9092   # Kafka

# View container logs
docker compose logs postgres
docker compose logs redis
docker compose logs kafka
```

### Data Processor Shows "Unauthorized IMEI"

This means the device's IMEI hasn't been registered via `POST /api/v1/devices`. Register it first.

```bash
# Check Redis for the IMEI
docker exec fv-redis redis-cli HGETALL "auth:YOUR_IMEI_HERE"
```

### Prisma Errors

```bash
# Regenerate Prisma client
npm run db:generate

# Force reset database (WARNING: deletes all data)
cd packages/db && npx dotenv -e ../../.env -- prisma db push --force-reset
```

### Kafka Connection Issues

```bash
# Check Kafka is healthy
docker exec fv-kafka kafka-broker-api-versions --bootstrap-server localhost:9092

# List topics
docker exec fv-kafka kafka-topics --bootstrap-server localhost:9092 --list
```
