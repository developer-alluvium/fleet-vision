# Fleet Vision Enterprise Backend Documentation

> **Complete Technical Architecture, Data Pipeline, Ingestion Protocol, Storage Engine, and API Reference**  
> Workspace: `fleet-vision` | Monorepo Engine: **Turborepo** + **npm Workspaces**

---

## Table of Contents

1. [System Architecture & Overview](#1-system-architecture--overview)
2. [Monorepo Workspace Structure](#2-monorepo-workspace-structure)
3. [Infrastructure & Environment Configuration](#3-infrastructure--environment-configuration)
4. [Shared Database Layer (`packages/db`)](#4-shared-database-layer-packagesdb)
   - [Data Model & Entities](#data-model--entities)
   - [TimescaleDB Hypertables & PostGIS](#timescaledb-hypertables--postgis)
   - [Redis Helper Library & Cache Layer](#redis-helper-library--cache-layer)
5. [TCP Ingestion Gateway (`apps/tcp-server`)](#5-tcp-ingestion-gateway-appstcp-server)
   - [Teltonika Protocol & Codec 8 / 8E Parsing](#teltonika-protocol--codec-8--8e-parsing)
   - [Connection Lifecycle & Handshake](#connection-lifecycle--handshake)
   - [Zero-Loss Kafka Publishing & ACK Strategy](#zero-loss-kafka-publishing--ack-strategy)
6. [Data Processor & Pipeline Engine (`apps/data-processor`)](#6-data-processor--pipeline-engine-appsdata-processor)
   - [Kafka Batch Consumption Pipeline](#kafka-batch-consumption-pipeline)
   - [Authentication & Multi-Tenant Enforcement](#authentication--multi-tenant-enforcement)
   - [Sensor Mapping & Piecewise Fuel Calibration](#sensor-mapping--piecewise-fuel-calibration)
   - [Storage Routing & Pub/Sub Dispatch](#storage-routing--pubsub-dispatch)
   - [Background Workers & Schedulers](#background-workers--schedulers)
7. [API Gateway & Real-Time Streams (`apps/web-dashboard`)](#7-api-gateway--real-time-streams-appsweb-dashboard)
   - [Authentication & Authorization Modes](#authentication--authorization-modes)
   - [REST API Endpoints Specification](#rest-api-endpoints-specification)
   - [Server-Sent Events (SSE) Real-Time Streams](#server-sent-events-sse-real-time-streams)
   - [Historical Query Engine & Douglas-Peucker Simplification](#historical-query-engine--douglas-peucker-simplification)
8. [Redis Key Schema & Pub/Sub Topology](#8-redis-key-schema--pubsub-topology)
9. [Development, Deployment & Operational Runbook](#9-development-deployment--operational-runbook)

---

## 1. System Architecture & Overview

**Fleet Vision** is an enterprise-grade, multi-tenant, Bring-Your-Own-Device (BYOD) telematics backend engineered for high throughput, sub-second latency, and horizontal scalability. The platform ingests telemetry packets from GPS tracking devices (primarily Teltonika hardware), verifies tenant authorization in $O(1)$, stores hot and historical time-series data, and serves live positions and analytics via REST APIs and Server-Sent Events (SSE).

### High-Level Architecture Diagram

```
                             [ Teltonika GPS Hardware ]
                                         │
                         TCP Connection  │ Codec 8 / 8E AVL Packets
                         (Port 8500)     ▼
                     ┌───────────────────────────────────────┐
                     │          apps/tcp-server              │
                     │          (Go TCP Gateway)             │
                     └───────────────────┬───────────────────┘
                                         │  Publish Raw JSON
                                         │  Topic: "telemetry-raw"
                                         ▼
                     ┌───────────────────────────────────────┐
                     │            Apache Kafka               │
                     │         (KRaft Mode Cluster)          │
                     └───────────────────┬───────────────────┘
                                         │  Batch Consume
                                         ▼
                     ┌───────────────────────────────────────┐
                     │        apps/data-processor            │
                     │     (Node.js / TypeScript)            │
                     └───────┬───────────────────────┬───────┘
                             │                       │
      O(1) Auth Check &      │                       │ Bulk Telemetry Writes
      Live Map Updates       ▼                       ▼ (TimescaleDB Hypertables)
   ┌───────────────────────────┐           ┌───────────────────────────┐
   │           Redis           │           │   TimescaleDB (Postgres)  │
   │  • auth:{imei}            │           │  • organizations          │
   │  • live_map:org:{orgId}   │           │  • devices & vehicles     │
   │  • Pub/Sub channels       │           │  • telemetry_records      │
   │  • fleet_status caches    │           │  • PostGIS Geofences      │
   └─────────────┬─────────────┘           └─────────────┬─────────────┘
                 │                                       │
                 │ Pub/Sub Streams                       │ Relational & Historical
                 │ & O(1) Cache Reads                    │ Time-Series Queries
                 └───────────────────┬───────────────────┘
                                     │
                                     ▼
                     ┌───────────────────────────────────────┐
                     │          apps/web-dashboard           │
                     │        (Next.js 15 REST / SSE)        │
                     └───────────────────┬───────────────────┘
                                         │
                                         ▼
                     [ Client Applications / Dispatch UI ]
```

### Core Architectural Highlights

1. **Decoupled Ingestion**: The Go-based TCP gateway does not interact with the primary database. It parses binary packets and writes directly to Kafka. This isolates network volatility from persistence and ensures the server never blocks under load.
2. **Strict Multi-Tenancy**: Every vehicle, device, geofence, and telemetry record is strictly isolated under an `organizationId`. Queries and streams enforce organization scoping at the database and cache level.
3. **Dual-Tier Storage Strategy**:
   - **Hot Real-Time Tier (Redis)**: Current vehicle locations, ignition statuses, and telemetry summaries are updated in Redis hashes for $O(1)$ read performance. Live fleet maps bypass PostgreSQL entirely.
   - **Historical Time-Series Tier (TimescaleDB)**: Raw telemetry records are persisted to a PostgreSQL table converted into a TimescaleDB **Hypertable** partitioned by `time`.
   - **Cold Archival Tier (Apache Parquet)**: Nightly worker archives records older than the retention threshold to compressed Parquet files.
4. **Resilient Acknowledgement (ACK)**: The TCP gateway only acknowledges Teltonika devices after Kafka has verified persistence of the message. If Kafka is unavailable, the device retains its unacknowledged records in its internal flash buffer and resends upon reconnection.

---

## 2. Monorepo Workspace Structure

The project is configured as an npm workspaces monorepo managed by **Turborepo** (`turbo.json`).

```
fleet-vision/
├── package.json                   # Root workspace manifest & npm scripts
├── turbo.json                     # Turborepo pipeline (build, lint, dev)
├── docker-compose.yml             # Infrastructure stack: TimescaleDB, Redis, Kafka
├── .env                           # Root environment variables
├── .env.example                   # Environment configuration template
│
├── apps/
│   ├── tcp-server/                # Ingestion Gateway (Go v1.20+)
│   │   ├── main.go                # TCP listener, graceful shutdown, env loader
│   │   ├── handler.go             # IMEI handshake & AVL data packet framing
│   │   ├── producer.go            # Segmentio Kafka producer client
│   │   ├── parser/
│   │   │   ├── codec8.go          # Teltonika Codec 8 & Codec 8E parser + CRC16
│   │   │   ├── types.go           # Ingestion structs and types
│   │   │   └── codec8_test.go     # Unit tests for binary decoders
│   │   └── go.mod                 # Go module dependencies
│   │
│   ├── data-processor/            # Kafka Consumer & Worker Suite (Node.js/TS)
│   │   ├── src/
│   │   │   ├── index.ts           # Service bootstrapper and worker scheduler
│   │   │   ├── consumer.ts        # KafkaJS batch consumer client
│   │   │   ├── processor.ts       # Telemetry pipeline, fuel calibration & bulk insert
│   │   │   └── workers/
│   │   │       ├── fleet-status.ts          # State machine: RUNNING/IDLE/STOPPED
│   │   │       ├── geofence-worker.ts       # PostGIS ST_Contains alert checks
│   │   │       ├── subscription-enforcer.ts # Billing & cache revocation cron
│   │   │       └── cold-storage.ts          # Parquet export & DB pruning cron
│   │   └── package.json
│   │
│   └── web-dashboard/             # API Gateway & Management Web App (Next.js 15)
│       ├── src/
│       │   ├── middleware.ts      # CORS and cookie preflight middleware
│       │   ├── lib/
│       │   │   ├── auth.ts              # Unified JWT & API Key validator
│       │   │   ├── douglasPeucker.ts    # GPS path simplification algorithm
│       │   │   └── journeySummary.ts    # Trip aggregation (mileage, speeds, fuel)
│       │   └── app/api/v1/              # Version 1 REST & SSE Endpoints
│       │       ├── auth/                # Login, Logout, Token Refresh, Me
│       │       ├── organizations/       # Org provisioning & API Key management
│       │       ├── devices/             # BYOD device provisioning & listing
│       │       ├── vehicles/            # Fleet vehicle metadata & calibration
│       │       ├── live-locations/      # Fast Redis-backed fleet snapshots
│       │       ├── track-vehicle/       # Multi-IMEI bulk position lookup
│       │       ├── history/             # TimescaleDB + Parquet route history
│       │       ├── journey/             # Time-filtered journey points
│       │       └── stream/              # SSE streams (fleet, journey, fleet-status)
│       └── package.json
│
├── packages/
│   └── db/                        # Shared Data Package (@fleet-vision/db)
│       ├── prisma/
│       │   └── schema.prisma      # Multi-tenant schema with PostGIS extension
│       ├── src/
│       │   ├── index.ts           # Prisma singleton & unified re-exports
│       │   ├── redis.ts           # ioredis client singleton & helper routines
│       │   └── fuelCalibration.ts # Piecewise linear interpolation math
│       └── package.json
│
└── archives/                      # Parquet cold storage output directory
```

---

## 3. Infrastructure & Environment Configuration

The local development and production environments run on Docker Compose (`docker-compose.yml`).

### Infrastructure Services

| Service | Image | Container Port | Host Port | Role |
|---|---|---|---|---|
| **TimescaleDB** | `timescale/timescaledb-ha:pg15-latest` | `5432` | `5432` | Relational data, PostGIS geofences, and time-series hypertables |
| **Redis** | `redis:alpine` | `6379` | `6379` | $O(1)$ Device auth cache, live vehicle locations hash, Pub/Sub message broker |
| **Kafka** | `confluentinc/cp-kafka:7.6.0` | `9092` | `9092` | KRaft-mode message broker (ZooKeeper-less) decoupling ingestion |

### Core Environment Variables Reference

Defined in `.env` at root and inherited by workspaces:

```env
# ── TimescaleDB / PostgreSQL ─────────────────────────────
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fleet_vision?schema=public"

# ── Redis ─────────────────────────────────────────────────
REDIS_URL="redis://localhost:6379"

# ── Apache Kafka ──────────────────────────────────────────
KAFKA_BROKERS="localhost:9092"
KAFKA_TOPIC="telemetry-raw"
KAFKA_CLIENT_ID="fleet-vision-processor"
KAFKA_GROUP_ID="fleet-vision-consumer-group"

# ── Go TCP Ingestion Server ──────────────────────────────
TCP_PORT=8500

# ── Web API & Dashboard ──────────────────────────────────
PORT=3000
JWT_SECRET="your_production_grade_jwt_secret_at_least_32_characters"
ACCESS_TOKEN_SECRET="your_production_grade_access_token_secret"
REFRESH_TOKEN_SECRET="your_production_grade_refresh_token_secret"

# ── Workers & Data Retention ─────────────────────────────
ENABLE_COLD_STORAGE=false          # Set true to enable nightly Parquet exports
RETENTION_MONTHS=6                 # Age after which records are archived and pruned
STALE_THRESHOLD_MINUTES=5          # Minutes without telemetry before device marks IDLE/STOPPED
INACTIVE_THRESHOLD_HOURS=24        # Hours without telemetry before marking INACTIVE
```

---

## 4. Shared Database Layer (`packages/db`)

All database and caching logic is centralized in `@fleet-vision/db` (`packages/db`), imported by both the Next.js API server and the background Data Processor.

### Data Model & Entities

Configured in `packages/db/prisma/schema.prisma`:

#### 1. `Organization` (`organizations`)
The root tenant entity. Every user, device, vehicle, and telemetry record belongs to an organization.
- `id`: `String` (CUID primary key)
- `name`: `String` (Organization name)
- `status`: `String` (`ACTIVE`, `SUSPENDED`, `CANCELLED`)
- `subscriptionPlan`: `String` (`TRIAL`, `ENTERPRISE`, etc.)
- `subscriptionEndDate`: `DateTime?`
- `apiKey`: `String?` (Unique 64-character hex key with `fv_live_` prefix)
- Relations: `User[]`, `Device[]`, `Vehicle[]`, `Geofence[]`

#### 2. `User` (`users`)
Operator or administrator accounts within an organization.
- `id`: `String` (CUID)
- `email`: `String` (Unique)
- `password`: `String?` (Bcrypt hash, 10 rounds)
- `role`: `String` (`ADMIN`, `MANAGER`, `VIEWER`)
- `organizationId`: Foreign key to `Organization` (Cascade delete)

#### 3. `Device` (`devices`)
Physical GPS telematics trackers registered under BYOD.
- `id`: `String` (CUID)
- `imei`: `String` (Unique 15-digit hardware IMEI identifier)
- `status`: `String` (`PENDING_CONNECTION`, `ONLINE`, `OFFLINE`)
- `organizationId`: Foreign key to `Organization` (Cascade delete)
- `vehicleId`: `String?` (Unique 1-to-1 link to `Vehicle`)

#### 4. `Vehicle` (`vehicles`)
Fleet assets associated with tracking devices and sensor calibrations.
- `id`: `String` (CUID)
- `plateNumber`: `String` (Unique license plate)
- `make`, `model`, `year`, `color`, `vin`, `vehicleType`, `fuelType`
- `maxFuelCapacity`: `Float?` (Total fuel tank capacity in liters)
- `bleFuelChannel`: `Int?` (Default `1`. Maps to Teltonika BLE sensor channel 1–4)
- Relations: `Device?`, `FuelCalibrationPoint[]`

#### 5. `FuelCalibrationPoint` (`fuel_calibration_points`)
Piecewise calibration lookup table mapping raw sensor frequency/ticks to physical fuel volume in liters.
- `id`: `String` (CUID)
- `vehicleId`: Foreign key to `Vehicle` (Cascade delete)
- `rawValue`: `Int` (Raw reading from BLE sensor, e.g., Escort TD-BLE Hz/frequency)
- `liters`: `Float` (Corresponding volume in liters)
- Unique constraint: `@@unique([vehicleId, rawValue])`

#### 6. `Geofence` (`geofences`)
Geographical boundary zones for location triggers.
- `id`: `String` (CUID)
- `name`: `String`
- `organizationId`: Foreign key to `Organization` (Cascade delete)
- `polygon`: `Unsupported("geometry(Polygon, 4326)")` (PostGIS spatial geometry)
- Spatial index: `@@index([polygon], type: Gist)`

#### 7. `TelemetryRecord` (`telemetry_records`)
Raw telemetry time-series records ingested from Teltonika devices.
- `id`: `String` (CUID)
- `time`: `DateTime` (`@db.Timestamptz`) — Timestamp recorded by device satellite clock
- `imei`: `String`
- `organizationId`: `String`
- `latitude`, `longitude`, `speed`, `angle`
- `ignition`: `Boolean`
- Extracted IO elements: `gsmSignal`, `externalVoltage`, `internalBatteryVoltage`, `gnssStatus`, `batteryLevel`, `movement`, `odometer`, `tripOdometer`
- Fuel readings: `fuelLevelRaw` (`Int?`), `fuelLevelLiters` (`Float?`)
- `serverCreatedAt`: `DateTime` (`@db.Timestamptz`) — Server arrival timestamp
- Primary key: `@@id([id, time])` (Required for TimescaleDB partitioning)
- Indices: `[time(sort: Desc)]`, `[imei, time(sort: Desc)]`, `[organizationId, time(sort: Desc)]`

---

### TimescaleDB Hypertables & PostGIS

1. **Hypertable Conversion**:
   The `telemetry_records` table is partitioned into TimescaleDB chunk tables along the `time` dimension. To initialize the hypertable after running `npx prisma db push`:
   ```sql
   SELECT create_hypertable('telemetry_records', 'time', if_not_exists => TRUE);
   ```
2. **PostGIS Geometry Queries**:
   Geofence containment uses native PostGIS functions via Prisma's `$queryRawUnsafe`:
   ```sql
   SELECT id, name FROM "geofences"
   WHERE "organization_id" = $1
     AND ST_Contains(polygon, ST_SetSRID(ST_Point($2, $3), 4326));
   ```

---

### Redis Helper Library & Cache Layer

Defined in `packages/db/src/redis.ts`:

- `authorizeDevice(imei, orgId)`: Writes device authorization to `auth:{imei}` with hash fields `isAuthorized: 'true'`, `orgId`.
- `revokeDevice(imei)`: Removes `auth:{imei}` from Redis.
- `getDeviceAuth(imei)`: Returns `{ isAuthorized, orgId }` in $O(1)$.
- `updateLiveMap(orgId, imei, payload)`: Sets hash field `imei` in key `live_map:org:{orgId}` with the latest telemetry JSON.
- `getLiveMap(orgId)`: Fetches all active vehicle states for an organization (`HGETALL live_map:org:{orgId}`).
- `getLiveLocationsByImeis(orgId, imeis)`: Executes `HMGET live_map:org:{orgId} ...imeis` for selective multi-vehicle lookups.
- `publishLocationUpdate(orgId, imei, payload)`: Publishes telemetry update to Redis Pub/Sub channel `location:org:{orgId}`.
- `publishJourneyRecords(orgId, imei, records)`: Publishes point batches to Redis Pub/Sub channel `journey:device:{imei}`.
- `cacheVehicleFuelSettings(imei, settings)` & `cacheCalibrationTable(imei, table)`: In-memory cache for fast interpolation during ingestion.
- `computeDeviceStatus(payload, nowMs, staleThresholdMs, inactiveThresholdMs)`: State calculation engine returning `RUNNING`, `IDLE`, `STOPPED`, `INACTIVE`, or `NO_DATA`.
- `updateFleetStatus(orgId, statusMap, summary)`: Updates `fleet_status:org:{orgId}` and `fleet_status_summary:org:{orgId}`.

---

## 5. TCP Ingestion Gateway (`apps/tcp-server`)

The TCP Gateway is written in **Go** to maximize concurrency, minimize memory footprint, and handle thousands of simultaneous persistent socket connections.

### Teltonika Protocol & Codec 8 / 8E Parsing

Implemented in `apps/tcp-server/parser/codec8.go`:
- Supports both **Codec 8** (`0x08`) and **Codec 8 Extended / 8E** (`0x8E`).
- Codec 8 uses 1-byte field lengths for IO IDs and counts; Codec 8E uses 2-byte fields for larger parameter IDs (e.g., Bluetooth sensors, BLE fuel levels).

#### AVL Record Structure Decoded by Parser:
1. **Timestamp**: 8 bytes (Milliseconds since Unix epoch, UTC).
2. **Priority**: 1 byte (`0` = Low, `1` = High, `2` = Panic).
3. **GPS Element**:
   - Longitude (4 bytes, signed integer / $10^7$)
   - Latitude (4 bytes, signed integer / $10^7$)
   - Altitude (2 bytes, signed integer in meters)
   - Angle (2 bytes, unsigned integer $0^\circ$ to $360^\circ$)
   - Satellites (1 byte)
   - Speed (2 bytes, km/h)
4. **IO Event ID**: 1 byte (Codec 8) or 2 bytes (Codec 8E).
5. **IO Elements**:
   - 1-byte IO values
   - 2-byte IO values
   - 4-byte IO values
   - 8-byte IO values
   - Variable-length X-byte elements (Codec 8E only)

---

### Connection Lifecycle & Handshake

Defined in `apps/tcp-server/handler.go`:

```
Device (Teltonika)                                 Go TCP Gateway (Port 8500)
       │                                                      │
       │ ── 1. [2-byte Length] + [15-byte ASCII IMEI] ──────> │
       │                                                      │ Validate 15 digits
       │ <─ 2. [1-byte Response: 0x01 (Accept) / 0x00 (Deny)] ┤
       │                                                      │
       │ ── 3. AVL Data Packet ─────────────────────────────> │
       │       [4B: 0x00000000 Preamble]                      │
       │       [4B: Data Length]                              │ Verify CRC-16 (IBM)
       │       [AVL Payload (Codec 8/8E)]                     │ Parse Records
       │       [4B: CRC-16 Checksum]                          │
       │                                                      │
       │                                                      │ ── 4. Produce to Kafka ──>
       │                                                      │    Topic: telemetry-raw
       │                                                      │ <── Confirmed Write ──────
       │                                                      │
       │ <─ 5. [4-byte ACK: Number of Records Accepted] ──────┤
       │                                                      │
```

1. **Timeout Rules**:
   - Handshake Timeout: `10 seconds`
   - Read Timeout: `90 seconds` (Devices normally transmit every 30–60s)
   - Write Timeout: `5 seconds`
2. **CRC-16 Validation**: The server computes the 16-bit CRC over the data payload using the polynomial `0xA001` (CRC-16/IBM). If the CRC does not match, the packet is discarded and an error ACK (`0x00000000`) is returned.

---

### Zero-Loss Kafka Publishing & ACK Strategy

The TCP gateway uses `segmentio/kafka-go` in synchronous mode:
- When an AVL packet of $N$ records is successfully parsed, the gateway produces a JSON payload to the Kafka topic `telemetry-raw` partitioned by device IMEI:
  ```json
  {
    "imei": "352093081234567",
    "codec": "codec8",
    "server_timestamp": "2026-09-18T13:02:15.123456789Z",
    "records": [
      {
        "timestamp": "2026-09-18T13:02:14.000Z",
        "priority": 0,
        "longitude": 72.8777,
        "latitude": 19.0760,
        "altitude": 14,
        "angle": 182,
        "satellites": 14,
        "speed": 48,
        "event_id": 0,
        "io_elements": {
          "1": 1,
          "21": 4,
          "66": 12450,
          "239": 1,
          "270": 1845
        }
      }
    ]
  }
  ```
- **Strict ACK Guarantee**: The server **only** writes the 4-byte ACK containing $N$ records back to the TCP socket **after** Kafka has confirmed receipt. If Kafka fails or times out, the server sends `0` as ACK, forcing the device to retain the records in its local flash memory and retry.

---

## 6. Data Processor & Pipeline Engine (`apps/data-processor`)

The Data Processor runs as a continuous Node.js service (`apps/data-processor/src/consumer.ts` & `processor.ts`) consuming messages from Kafka in batches.

### Kafka Batch Consumption Pipeline

1. **Consumer Group**: Configured with `eachBatch` to process up to several hundred messages concurrently without per-message roundtrips.
2. **Batch Ingestion Flow**:

```
[ Kafka Batch Received ]
           │
           ▼
    Loop through each message
           │
           ├─► Extract IMEI
           │
           ├─► Redis O(1) Auth Check: HGETALL "auth:{imei}"
           │         │
           │         ├─► Not Authorized: Log warning & drop packet (droppedCount++)
           │         │
           │         └─► Authorized: Retrieve orgId, fuelSettings, calibrationTable
           │
           ├─► For each AVL record:
           │         ├─► Parse IO elements (Ignition, Voltages, Battery, GSM, Odometers)
           │         ├─► Extract BLE Fuel Reading (IO 270/273/276/279)
           │         ├─► Interpolate Liters via Piecewise Calibration Table
           │         └─► Append to validRecords array (with orgId injected)
           │
           ├─► Identify Most Recent Record (for Live Map):
           │         └─► If age < 2 minutes: Add to liveMapUpdates
           │
           └─► Collect all live records for Journey Pub/Sub stream
           │
           ▼
[ Database & Cache Operations ]
  1. Bulk Insert: prisma.telemetryRecord.createMany(validRecords)
  2. Redis Live Map Update: HSET "live_map:org:{orgId}"
  3. Redis Fleet Pub/Sub: PUBLISH "location:org:{orgId}"
  4. Redis Journey Pub/Sub: PUBLISH "journey:device:{imei}"
  5. State Machine: recomputeFleetStatus(orgId)
```

---

### Authentication & Multi-Tenant Enforcement

Tenant authorization is completely decoupled from PostgreSQL:
- The Data Processor reads Redis hash `auth:{imei}`:
  ```redis
  HGETALL auth:352093081234567
  # Returns: { isAuthorized: "true", orgId: "clxyz..." }
  ```
- If the key is missing or `isAuthorized !== 'true'`, the entire packet is dropped immediately.
- This ensures rogue or deactivated devices cannot flood the relational database with writes.

---

### Sensor Mapping & Piecewise Fuel Calibration

1. **Teltonika Standard IO Identifiers Extracted**:
   - `IO 239`: Ignition status (`1` = ON, `0` = OFF). Fallback: if `speed > 0`, ignition defaults to true.
   - `IO 21`: GSM Signal level (1–5 bars).
   - `IO 66`: External Power Voltage in mV (e.g., $12450\text{ mV} = 12.45\text{ V}$).
   - `IO 67`: Internal Battery Voltage in mV.
   - `IO 69`: GNSS Status (`0` = OFF, `1` = Fix, `2` = No Fix).
   - `IO 113`: Battery charge percentage (0–100%).
   - `IO 240`: Movement sensor (`1` = Moving, `0` = Stationary).
   - `IO 16`: Total odometer (meters).
   - `IO 199`: Trip odometer (meters).

2. **BLE Fuel Level Channels**:
   Teltonika trackers support up to 4 Escort TD-BLE sensors:
   - Channel 1 $\rightarrow$ `IO 270`
   - Channel 2 $\rightarrow$ `IO 273`
   - Channel 3 $\rightarrow$ `IO 276`
   - Channel 4 $\rightarrow$ `IO 279`

3. **Piecewise Linear Interpolation (`rawToLiters`)**:
   Implemented in `packages/db/src/fuelCalibration.ts`:
   Given sorted calibration points $(R_0, L_0), (R_1, L_1), \dots, (R_n, L_n)$:
   - If raw sensor value $R \le R_0 \implies L = L_0$
   - If raw sensor value $R \ge R_n \implies L = L_n$
   - If $R_i \le R \le R_{i+1}$, calculate:
     $$L = L_i + \frac{R - R_i}{R_{i+1} - R_i} \times (L_{i+1} - L_i)$$
   The resulting liters value is rounded to 2 decimal places and written to both `telemetry_records` and the Redis live map.

---

### Storage Routing & Pub/Sub Dispatch

To protect real-time displays from buffered historical data when a vehicle emerges from a cellular dead zone:
- **`LIVE_THRESHOLD_MS` (2 minutes)**:
  - If incoming records have timestamps older than 2 minutes, they are **only** bulk-inserted into TimescaleDB.
  - They do **not** overwrite the current position in `live_map:org:{orgId}` or trigger live map jump animations on dispatcher screens.
  - Recent points within 2 minutes are published to Redis channels `location:org:{orgId}` and `journey:device:{imei}`.

---

### Background Workers & Schedulers

Configured in `apps/data-processor/src/workers/` and scheduled via `node-cron`:

#### 1. Fleet Status State Machine (`fleet-status.ts`)
- **Trigger**: Runs after every telemetry batch and every 60 seconds via cron.
- **Statuses**:
  - `RUNNING`: Moving or ignition ON with speed $> 0$.
  - `IDLE`: Ignition ON, speed $= 0$, telemetry received within `STALE_THRESHOLD_MINUTES` (5m).
  - `STOPPED`: Ignition OFF, speed $= 0$, telemetry received within `STALE_THRESHOLD_MINUTES` (5m).
  - `INACTIVE`: No telemetry received for $\ge \text{STALE\_THRESHOLD\_MINUTES}$ (5m) but $< \text{INACTIVE\_THRESHOLD\_HOURS}$ (24h).
  - `NO_DATA`: No telemetry received for $> 24\text{ hours}$ or device never connected.
- **Output**: Diff is calculated; state transitions publish to `fleet_status:org:{orgId}` for real-time frontend badge updates.

#### 2. Geofence Alerts (`geofence-worker.ts`)
- Evaluates coordinates against PostGIS spatial polygons:
  ```sql
  SELECT id, name FROM geofences
  WHERE organization_id = $1
    AND ST_Contains(polygon, ST_SetSRID(ST_Point($lon, $lat), 4326));
  ```
- Emits alerts when a vehicle enters restricted or monitored operational zones.

#### 3. Subscription Enforcer (`subscription-enforcer.ts`)
- **Schedule**: Nightly at 00:00 UTC.
- Finds organizations where `subscriptionEndDate < NOW()` and `status = 'ACTIVE'`.
- Sets organization `status = 'SUSPENDED'`.
- Pipelined deletion of all device keys from Redis (`auth:{device.imei}`), instantly stopping downstream Kafka processing and database ingestion.

#### 4. Cold Storage Archival (`cold-storage.ts`)
- **Schedule**: Nightly cron (enabled when `ENABLE_COLD_STORAGE=true`).
- Queries telemetry records older than `RETENTION_MONTHS` (default: 6 months).
- Streams records in batches of 10,000 into Snappy-compressed **Apache Parquet** files (`telemetry_archive_<timestamp>.parquet`).
- Deletes the archived rows from TimescaleDB via raw partition cleanup:
  ```sql
  DELETE FROM "telemetry_records" WHERE "time" < $cutoffDate;
  ```

---

## 7. API Gateway & Real-Time Streams (`apps/web-dashboard`)

Built on Next.js 15 App Router Route Handlers (`src/app/api/v1/...`).

### Authentication & Authorization Modes

Implemented in `src/lib/auth.ts`:

1. **HttpOnly Cookies**: Browser session management via `accessToken` and `refreshToken`. `credentials: "include"` must be passed on web client fetch calls.
2. **Bearer Token**: Standard header:
   ```http
   Authorization: Bearer <jwt_access_token>
   ```
   (Query parameter fallback `?token=Bearer <jwt>` supported for Server-Sent Events).
3. **API Key (Machine-to-Machine)**:
   ```http
   x-api-key: fv_live_64_character_hex_key
   ```
   (Or query parameter `?apiKey=fv_live_...`).

---

### REST API Endpoints Specification

#### Authentication Endpoints

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | Authenticates email & password; sets HttpOnly cookies | No |
| `POST` | `/api/v1/auth/logout` | Revokes refresh token and clears auth cookies | Yes |
| `POST` | `/api/v1/auth/refresh` | Generates a new access token using refresh token | Cookie |
| `GET` | `/api/v1/auth/me` | Returns current user profile and organization info | Yes |

##### `POST /api/v1/auth/login`
- **Request Body**:
  ```json
  {
    "email": "admin@myfleet.com",
    "password": "securepassword123"
  }
  ```
- **Response (200 OK)**:
  ```json
  {
    "user": {
      "id": "clxyz123...",
      "email": "admin@myfleet.com",
      "organizationId": "clorg456...",
      "role": "ADMIN"
    }
  }
  ```

---

#### Organization Endpoints

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/v1/organizations` | Creates tenant organization and initial admin user | Superadmin |
| `GET` | `/api/v1/organizations` | Lists organizations with device and vehicle counts | Superadmin |
| `POST` | `/api/v1/organizations/api-key` | Generates or regenerates tenant API key | JWT Admin |
| `GET` | `/api/v1/organizations/api-key` | Retrieves the current organization's API key | JWT Admin |

##### `POST /api/v1/organizations/api-key`
- **Response (201 Created)**:
  ```json
  {
    "apiKey": "fv_live_a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef"
  }
  ```

---

#### Device Management Endpoints

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/v1/devices` | Registers a BYOD tracker and syncs to Redis auth | Yes |
| `GET` | `/api/v1/devices` | Paginated listing with optional search by IMEI/status | Yes |
| `GET` | `/api/v1/devices/[deviceId]` | Retrieves device details and linked vehicle info | Yes |
| `PUT` | `/api/v1/devices/[deviceId]` | Updates device metadata or status | Yes |
| `DELETE` | `/api/v1/devices/[deviceId]` | Unregisters device and evicts `auth:{imei}` from Redis | Yes |

##### `POST /api/v1/devices`
- **Request Body**:
  ```json
  {
    "imei": "352093081234567",
    "orgId": "clorg456..."
  }
  ```
- **Response (201 Created)**:
  ```json
  {
    "device": {
      "id": "cldev789...",
      "imei": "352093081234567",
      "status": "PENDING_CONNECTION",
      "organizationId": "clorg456...",
      "vehicleId": null,
      "createdAt": "2026-09-18T12:00:00.000Z"
    }
  }
  ```

---

#### Vehicle & Calibration Endpoints

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/v1/vehicles` | Registers a vehicle with plate number and capacity | Yes |
| `GET` | `/api/v1/vehicles` | Lists vehicles for organization with device pairings | Yes |
| `GET` | `/api/v1/vehicles/[vehicleId]` | Fetches vehicle metadata | Yes |
| `PUT` | `/api/v1/vehicles/[vehicleId]` | Updates vehicle specs, BLE channel, or pairings | Yes |
| `DELETE` | `/api/v1/vehicles/[vehicleId]` | Deletes vehicle and detaches associated device | Yes |
| `GET` | `/api/v1/vehicles/[vehicleId]/fuel-calibration-table` | Gets piecewise calibration curve points | Yes |
| `PUT` | `/api/v1/vehicles/[vehicleId]/fuel-calibration-table` | Replaces calibration points & updates Redis cache | Yes |
| `DELETE` | `/api/v1/vehicles/[vehicleId]/fuel-calibration-table` | Clears calibration points and flushes Redis cache | Yes |

##### `PUT /api/v1/vehicles/[vehicleId]/fuel-calibration-table`
- **Request Body**:
  ```json
  {
    "points": [
      { "rawValue": 1000, "liters": 0 },
      { "rawValue": 1500, "liters": 100 },
      { "rawValue": 2000, "liters": 250 },
      { "rawValue": 3000, "liters": 500 }
    ]
  }
  ```
- **Validation Rules**:
  - Must contain at least 2 points.
  - `rawValue` and `liters` must be $\ge 0$.
  - No duplicate `rawValue` entries.
  - `liters` must be monotonically increasing.
  - `liters` cannot exceed `vehicle.maxFuelCapacity`.

---

#### Location & Tracking Endpoints

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/v1/live-locations?orgId=...` | Returns all active vehicles from Redis live map | Yes |
| `POST` | `/api/v1/track-vehicle` | Batch location lookup for specific IMEIs (max 50) | Yes |

##### `POST /api/v1/track-vehicle`
Designed for external enterprise integrations (e.g., electronic shipping notes / LR tracking).
- **Request Body**:
  ```json
  {
    "imeis": ["352093081234567", "352093087654321"]
  }
  ```
- **Response (200 OK)**:
  ```json
  {
    "results": [
      {
        "imei": "352093081234567",
        "found": true,
        "location": {
          "imei": "352093081234567",
          "latitude": 19.0760,
          "longitude": 72.8777,
          "speed": 42.5,
          "angle": 180,
          "ignition": true,
          "fuelLevelRaw": 2100,
          "fuelLevelLiters": 280.5,
          "odometer": 1450200,
          "timestamp": "2026-09-18T13:00:00.000Z",
          "updatedAt": "2026-09-18T13:00:01.120Z"
        }
      }
    ]
  }
  ```

---

#### History & Journey Endpoints

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/v1/history` | Full historical query with Douglas-Peucker & metrics | Yes |
| `GET` | `/api/v1/journey` | Lightweight time-filtered historical point stream | Yes |

##### `GET /api/v1/history?imei=xxx&start=...&end=...`
Queries both hot TimescaleDB hypertable data and cold Parquet archives, sorts chronologically, executes route simplification, and returns trip statistics.

- **Query Parameters**:
  - `imei` (Required): 15-digit device IMEI
  - `start` (Optional): ISO 8601 start timestamp (default: 24h ago)
  - `end` (Optional): ISO 8601 end timestamp (default: now)
  - `orgId` (Optional): Organization ID (derived from auth token if omitted)
- **Response (200 OK)**:
  ```json
  {
    "imei": "352093081234567",
    "orgId": "clorg456...",
    "summary": {
      "totalDistanceKm": 142.6,
      "maxSpeedKmh": 78.4,
      "averageSpeedKmh": 41.2,
      "movingDurationMs": 12480000,
      "idleDurationMs": 1800000,
      "stoppedDurationMs": 3600000,
      "initialFuelLiters": 420.0,
      "finalFuelLiters": 372.5,
      "fuelConsumedLiters": 47.5
    },
    "route": [
      {
        "lat": 19.0760,
        "lng": 72.8777,
        "speed": 45,
        "ignition": true,
        "fuelLevelLiters": 418.2,
        "time": "2026-09-18T08:00:00.000Z"
      }
    ],
    "metadata": {
      "totalTelemetryPoints": 3480,
      "returnedRoutePoints": 420,
      "simplified": true,
      "queryTimeMs": 28
    }
  }
  ```

---

### Server-Sent Events (SSE) Real-Time Streams

All SSE endpoints implement HTTP/1.1 persistent streaming with:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`
- `X-Accel-Buffering: no` (disables Nginx reverse-proxy buffering)
- Heartbeat frames (`: heartbeat\n\n`) sent every 30 seconds to prevent NAT/proxy timeouts.

#### 1. Fleet Live Stream (`/api/v1/stream/fleet`)
Pushes real-time location updates for all vehicles in the tenant's fleet.
- **Event `init`**: Transmitted immediately upon connection containing the initial snapshot of all devices and their current positions from Redis.
- **Event `location:update`**: Emitted whenever any device in the organization produces fresh telemetry.

#### 2. Vehicle Journey Stream (`/api/v1/stream/journey?imei=...&since=...`)
Provides continuous live tracking for an individual vehicle with historical catch-up.
- **Race-Condition-Free Initialization**:
  1. Subscribes to Redis Pub/Sub channel `journey:device:{imei}` first and buffers incoming messages.
  2. Queries historical points from TimescaleDB where `time >= since`.
  3. Emits event `journey:history` with historical points.
  4. Flushes buffered live points as `journey:point` events.
  5. Continues streaming live points as they arrive.

#### 3. Fleet Status Summary Stream (`/api/v1/stream/fleet-status`)
Live state-machine counts for dashboard status badges.
- **Event `init`**: Initial count breakdown:
  ```json
  {
    "counts": {
      "TOTAL": 25,
      "RUNNING": 14,
      "IDLE": 3,
      "STOPPED": 6,
      "INACTIVE": 2,
      "NO_DATA": 0
    },
    "computedAt": "2026-09-18T13:00:00.000Z"
  }
  ```
- **Event `update`**: Pushed whenever a vehicle transitions states (e.g., from `RUNNING` to `IDLE`).

---

### Historical Query Engine & Douglas-Peucker Simplification

Large fleet queries can return tens of thousands of GPS points, causing browser memory lag and SVG/WebGL rendering freezes.

Fleet Vision includes an adaptive **Ramer-Douglas-Peucker (RDP)** algorithm (`apps/web-dashboard/src/lib/douglasPeucker.ts`):
- **Point Threshold**: If query yields $\le 500$ points, raw coordinates are returned without reduction.
- **Adaptive Epsilon**:
  - $501 - 2,000$ points $\implies \epsilon = 0.00005^\circ$ ($\approx 5.5\text{ meters}$)
  - $2,001 - 10,000$ points $\implies \epsilon = 0.00010^\circ$ ($\approx 11\text{ meters}$)
  - $> 10,000$ points $\implies \epsilon = 0.00020^\circ$ ($\approx 22\text{ meters}$)
- **Preserved Turning Angles**: Points representing sharp vehicle turns ($> 30^\circ$) or ignition changes are retained regardless of distance tolerance to maintain route fidelity.

---

## 8. Redis Key Schema & Pub/Sub Topology

Redis serves as the low-latency caching and message distribution backbone.

### Key Naming Conventions

| Key Pattern | Type | Expiration | Description |
|---|---|---|---|
| `auth:{imei}` | Hash | Persistent | Device authorization cache. Fields: `isAuthorized: "true"`, `orgId: "<cuid>"`. |
| `live_map:org:{orgId}` | Hash | Persistent | Latest position per vehicle. Key: `imei`, Value: JSON payload. |
| `vehicle:fuel_settings:{imei}` | String | 1 Hour | Cached BLE channel setting (`{ bleFuelChannel: 1 }`). |
| `vehicle:calibration:{imei}` | String | 1 Hour | Cached calibration table array (`[{ rawValue, liters }]`). |
| `fleet_status:org:{orgId}` | Hash | Persistent | Current status per device (`imei` $\rightarrow$ `RUNNING`/`IDLE`/`STOPPED`). |
| `fleet_status_summary:org:{orgId}` | Hash | Persistent | Aggregate counts (`TOTAL`, `RUNNING`, `IDLE`, `STOPPED`, `INACTIVE`). |

### Pub/Sub Channel Topology

| Channel Pattern | Producer | Consumers | Payload Description |
|---|---|---|---|
| `location:org:{orgId}` | `data-processor` | `/api/v1/stream/fleet` | Latest telemetry payload for a single vehicle. |
| `journey:device:{imei}` | `data-processor` | `/api/v1/stream/journey` | Array of recent GPS records with coordinates, speed, and fuel. |
| `fleet_status:org:{orgId}` | `data-processor` | `/api/v1/stream/fleet-status` | State change diff array and updated summary counts. |

---

## 9. Development, Deployment & Operational Runbook

### Prerequisites
- **Node.js**: v20.x or later
- **Go**: v1.20 or later
- **Docker & Docker Compose**: v2.20+

### Step-by-Step Local Setup

1. **Clone & Install Dependencies**:
   ```bash
   git clone <repository_url> fleet-vision
   cd fleet-vision
   npm install
   ```

2. **Start Infrastructure Stack**:
   ```bash
   npm run infra:up
   # Verifies containers: fv-postgres, fv-redis, fv-kafka
   ```

3. **Initialize Database & Prisma Client**:
   ```bash
   npm run db:push
   npm run db:generate
   ```

4. **Initialize TimescaleDB Hypertable**:
   Execute the following SQL command against PostgreSQL (port 5432):
   ```sql
   SELECT create_hypertable('telemetry_records', 'time', if_not_exists => TRUE);
   ```

5. **Start All Services in Parallel**:
   ```bash
   npm run dev:all
   ```
   * **Web API Server**: [http://localhost:3000](http://localhost:3000)
   * **Go TCP Server**: Listening on `0.0.0.0:8500`
   * **Data Processor**: Listening to Kafka topic `telemetry-raw`
   * **Prisma Studio**: `npm run db:studio` (available at [http://localhost:5555](http://localhost:5555))

---

### Verifying Ingestion with Simulated Hardware

To test the full end-to-end pipeline without physical Teltonika hardware:

1. **Register a Test Device via API**:
   ```bash
   # 1. Log in or create an organization
   curl -X POST http://localhost:3000/api/v1/organizations \
     -H "Content-Type: application/json" \
     -d '{"name": "Fleet Corp", "adminEmail": "admin@fleetcorp.com", "password": "password123"}'

   # 2. Register device IMEI (e.g. 352093081234567) using returned orgId
   curl -X POST http://localhost:3000/api/v1/devices \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"imei": "352093081234567", "orgId": "<orgId>"}'
   ```

2. **Inject Raw Teltonika Packet over TCP**:
   Send a raw Codec 8 binary packet to port 8500 using `nc` (netcat) or a test Go/Python script.
   The Go gateway will:
   - Perform IMEI handshake (`0x01` response).
   - Read AVL packet and verify CRC.
   - Produce message to Kafka topic `telemetry-raw`.
   - Send 4-byte record ACK to the socket.

3. **Verify Pipeline Output**:
   - Check processor console logs:
     ```text
     [PROCESSOR] 📡 Processing 1 record(s) for IMEI: 352093081234567
     [PROCESSOR] ✓ Bulk inserted 1 records from 1 devices
     ```
   - Query live locations:
     ```bash
     curl -H "Authorization: Bearer <token>" "http://localhost:3000/api/v1/live-locations?orgId=<orgId>"
     ```

---

### Production Deployment & Scaling Guidelines

1. **Go TCP Gateway**:
   - Stateless service. Scale horizontally behind a Layer 4 (TCP) Load Balancer (e.g., AWS NLB or HAProxy).
   - Use sticky sessions or round-robin; Teltonika devices maintain long-lived persistent TCP sockets.
2. **Kafka Cluster**:
   - Partition `telemetry-raw` topic by IMEI (used as the message key). This ensures that packets for any single vehicle are processed in strict chronological order while enabling horizontal scaling across consumer instances.
3. **Data Processor**:
   - Scale consumer instances up to the number of Kafka partitions.
   - Each instance handles a subset of partition assignments via Kafka consumer group balancing.
4. **TimescaleDB Compression & Retention**:
   - In production, enable TimescaleDB native compression policies for chunks older than 7 days:
     ```sql
     ALTER TABLE telemetry_records SET (
       timescaledb.compress,
       timescaledb.compress_segmentby = 'organization_id, imei'
     );
     SELECT add_compression_policy('telemetry_records', INTERVAL '7 days');
     ```
