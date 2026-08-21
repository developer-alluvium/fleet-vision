# Fleet Vision Enterprise

Welcome to the **Fleet Vision** workspace! This is an enterprise-grade, multi-tenant, BYOD (Bring Your Own Device) telematics backend. It receives GPS telemetry from Teltonika tracking devices installed in vehicles, authenticates them against tenant organizations, processes the data through a high-throughput pipeline, and serves real-time and historical fleet data via REST APIs.

---

## 🏗️ Architecture Overview & Data Flow

```text
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
│   └──────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Complete Data Flow Workflow
1. **Device Ingestion**: Physical GPS devices (e.g., Teltonika) send AVL packets over TCP to the Gateway on Port 8500.
2. **Kafka Queue**: The Gateway parses the binary protocol (Codec 8/8E) into structured JSON and pushes it to a Kafka topic (`telemetry-raw`).
3. **Processing & Auth**: The Data Processor consumes Kafka batches, checks Redis (`auth:{imei}`) to verify if the device is registered and to which Organization it belongs (Tenant Isolation). Unauthorized packets are dropped instantly.
4. **Storage & Live Map**: 
   - The Processor updates the Redis Live Map (`live_map:org:{orgId}`) for O(1) real-time tracking.
   - The Processor bulk-inserts the telemetry data into TimescaleDB (PostgreSQL) into a `telemetry_records` hypertable for historical reporting.
5. **Consumption**: The Next.js API provides REST endpoints (`/api/v1/...`) to fetch live locations directly from Redis (fast) and historical routes from TimescaleDB.

---

## 📦 Detailed Module Information

The project is structured as a **Turborepo** monorepo using npm workspaces.

### 1. TCP Gateway (`apps/tcp-server`)
- **Environment:** Go (Golang)
- **Role:** High-concurrency Ingestion Gateway.
- **Features:** 
  - Listens on TCP Port 8500.
  - Handles Teltonika Codec 8/8E binary protocol parsing.
  - Acknowledges device payloads.
  - Acts as a Kafka Producer, publishing raw JSON payloads to the `telemetry-raw` topic.

### 2. Data Processor (`apps/data-processor`)
- **Environment:** Node.js + TypeScript
- **Role:** Heavy lifting, authentication, and background jobs.
- **Features:**
  - **Kafka Consumer:** Reads telemetry streams in batches.
  - **Auth Layer:** Fast IMEI verification via Redis. Injects tenant `orgId` into validated payloads.
  - **Live State Manager:** Constantly updates the Redis hashes with the latest known device coordinates.
  - **Database Writer:** Buffers and bulk-inserts records into TimescaleDB to handle massive write loads efficiently.
  - **Background Workers:** Handles tasks like Geofence checks, cold storage archival, and subscription enforcement.

### 3. Web Dashboard & API (`apps/web-dashboard`)
- **Environment:** Next.js 15 (App Router), Tailwind CSS v4
- **Role:** Control plane and data delivery layer.
- **Features:**
  - **REST API (Control Plane):** Endpoints to provision organizations, vehicles, users, and devices.
  - **REST API (Data Plane):** High-speed endpoints to pull `/live-locations` from Redis and complex spatial `/history` queries from PostGIS.
  - **Multi-Tenancy:** Strictly isolates data. All requests require and filter by `orgId`.
  - **Frontend:** Provides a clean, minimalist UI for managing the fleet system.

### 4. Database Package (`packages/db`)
- **Environment:** Prisma 6, TypeScript
- **Role:** Shared data access layer.
- **Features:**
  - Contains the Prisma schema (`schema.prisma`) mapping models like `Organization`, `User`, `Device`, `Vehicle`, and `TelemetryRecord`.
  - Exports a singleton Prisma Client for DB connections.
  - Exports a singleton Redis Client for caching and live maps.
  - Shared across both Next.js and the Node.js Data Processor to ensure type consistency.

---

## 🛠️ Tech Stack & Infrastructure Dependencies

- **Database**: TimescaleDB (PostgreSQL 15) with PostGIS extension for time-series telemetry and spatial queries.
- **Cache**: Redis for O(1) device authentication lookups and live fleet location mapping.
- **Message Broker**: Apache Kafka (KRaft mode) with Zookeeper for decoupling high-frequency TCP ingestion from data processing.
- **Monorepo Tools**: Turborepo, npm workspaces, concurrently.

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18 or v20+ recommended.
- **Docker & Docker Compose**: Required for running the infrastructure (DB, Redis, Kafka).
- **Go**: v1.20+ (if working on the TCP gateway directly).

### 2. Install Dependencies
Run the following command from the root directory to install all workspaces dependencies:
```bash
npm install
```

### 3. Start Infrastructure
Boot up TimescaleDB, Redis, and Kafka using Docker Compose:
```bash
npm run infra:up
```

### 4. Database Setup
Push the Prisma schema to the database (and create the tables):
```bash
npm run db:push
```
*(Note: The `telemetry_records` table is designed to be converted to a TimescaleDB hypertable for production scale).*

### 5. Start Development Servers
Run the single dev command from the root folder:
```bash
npm run dev:all
```
This launches the applications simultaneously:
* **Web Dashboard (Next.js):** [http://localhost:3000](http://localhost:3000)
* **TCP Server (Go Gateway):** Listening on Port 8500
* **Data Processor (Node.js):** Consuming from Kafka in the background

---

## ⚙️ Runbook & Operations

| Command | Description |
|---|---|
| `npm run dev:all` | Start Next.js + Node Processor + Go TCP Server |
| `npm run dev` | Start just Next.js + Node Processor |
| `npm run infra:up` | Start Postgres (Timescale), Redis, Kafka via Docker |
| `npm run infra:down` | Stop and remove infrastructure containers |
| `npm run infra:logs` | Follow logs for Docker containers |
| `npm run db:push` | Push schema changes to development database |
| `npm run db:generate` | Regenerate Prisma Client (run after schema changes) |
| `npm run db:studio` | Open Prisma Studio GUI to view data |
| `npm run build` | Build all workspace applications |
| `npm run lint` | Run static analysis and linting |

---

## 📡 Connecting a Teltonika Device

To test the end-to-end flow with a real hardware tracker:
1. Open the **Teltonika Configurator**.
2. Navigate to **GPRS → Server Settings**.
3. Set **Domain** to your server IP, **Port** to `8500`, and **Protocol** to `TCP`.
4. Save to device.

> **CRITICAL:** The device's IMEI must be registered in the system via the Control Plane API (`POST /api/v1/devices`) and assigned to an organization BEFORE the Data Processor will accept its telemetry data. Unregistered IMEIs are automatically dropped.

---

## 🚨 Key Principles for Developers

1. **Strict Multi-Tenancy**: Every data point and device is tied to an `organizationId`. Never bypass tenant isolation.
2. **Performance Constraints**: 
   - Never query PostgreSQL for "live" or "latest" device location. Always use the Redis `live_map:org:{orgId}` hash.
   - Do not write telemetry directly from the Next.js API. All writes must go through Kafka -> Data Processor -> Bulk Insert.
3. **Schema Changes**: When modifying `packages/db/prisma/schema.prisma`, run `npm run db:generate` to update the shared Prisma client.
