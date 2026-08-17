# Fleet Vision - Overall Project Documentation

This document serves as a comprehensive overview of the **Fleet Vision** project. It is specifically designed to provide context to AI tools or new developers for understanding the architecture, tech stack, and codebase structure, enabling them to plan future requirements, add new features, or debug effectively.

## 1. Project Overview
**Fleet Vision** is an enterprise-grade, multi-tenant, BYOD (Bring Your Own Device) telematics backend. It receives GPS telemetry from Teltonika tracking devices installed in vehicles via TCP, authenticates the devices against tenant organizations, processes the data through a high-throughput pipeline (Kafka), and serves both real-time (Redis) and historical (TimescaleDB) fleet data via REST APIs (Next.js).

## 2. Tech Stack
The project is structured as a **Turborepo** monorepo using npm workspaces.

### Infrastructure (Dockerized)
- **Database**: TimescaleDB (PostgreSQL 15) with PostGIS extension for time-series telemetry and spatial queries.
- **Cache / In-Memory Store**: Redis for O(1) device authentication lookups and live fleet location mapping.
- **Message Broker**: Apache Kafka (KRaft mode) for decoupling high-frequency TCP ingestion from data processing.

### Applications (in `apps/`)
- **TCP Gateway (`apps/tcp-server`)**: Written in **Go**. Listens on Port 8500. Handles Teltonika Codec 8/8E binary protocol parsing and publishes raw JSON payloads to Kafka.
- **Data Processor (`apps/data-processor`)**: Written in **Node.js + TypeScript**. Consumes messages from Kafka in batches. Authenticates devices via Redis, injects tenant/organization IDs, updates the live location map in Redis, and performs bulk inserts into TimescaleDB. Also contains background workers (e.g., Geofence checks, subscription enforcement).
- **Web Dashboard & API (`apps/web-dashboard`)**: Written in **Next.js 15 (App Router)**. Serves as the REST API server for control plane (Organizations, Devices provisioning) and data plane (Live Locations, History queries). Uses Tailwind CSS v4 for the frontend.

### Shared Packages (in `packages/`)
- **Database Package (`@fleet-vision/db` inside `packages/db`)**: Contains the **Prisma 6** schema (`schema.prisma`), Prisma Client singleton, and Redis client singleton. Shared across Next.js and the Node.js Data Processor.

## 3. Architecture & Data Flow
1. **Device Ingestion**: Teltonika physical GPS devices send AVL packets over TCP to the Go Gateway (Port 8500).
2. **Kafka Queue**: The Go Gateway parses the binary protocol and pushes structured JSON to a Kafka topic.
3. **Processing & Auth**: The Node.js Data Processor consumes Kafka batches. It checks Redis (`auth:{imei}`) to verify if the device is registered and to which Organization it belongs (Tenant Isolation). Unauthorized packets are dropped.
4. **Storage & Live Map**: 
   - The Processor updates the Redis Live Map (`live_map:org:{orgId}`) for real-time tracking.
   - The Processor bulk-inserts the telemetry data into TimescaleDB (PostgreSQL) into a `telemetry_records` hypertable.
5. **Consumption**: The Next.js API provides endpoints (`/api/v1/...`) to fetch live locations directly from Redis (fast) and historical routes from TimescaleDB.

## 4. Repository Structure
```text
fleet-vision/
├── package.json              # Root workspace config (npm workspaces)
├── turbo.json                # Turborepo pipeline configuration
├── docker-compose.yml        # Infra: Postgres (Timescale), Redis, Kafka
├── .env                      # Global environment variables
├── apps/
│   ├── web-dashboard/        # Next.js App Router frontend + APIs
│   ├── tcp-server/           # Go TCP server for Teltonika devices
│   └── data-processor/       # Node.js Kafka consumer & background workers
└── packages/
    └── db/                   # Shared Prisma ORM and Redis clients
```

## 5. Development & Running the Project
- **Prerequisites**: Node.js v20+, Go v1.20+, Docker Desktop.
- **Start Infrastructure**: `npm run infra:up` (Starts TimescaleDB, Redis, Kafka via Docker Compose).
- **Database Setup**: `npm run db:push` (Pushes Prisma schema). The `telemetry_records` table must be manually converted to a TimescaleDB hypertable using SQL.
- **Start Application**: `npm run dev:all` (Starts Next.js, Go TCP Server, and Node.js Processor concurrently).
- **Database UI**: `npm run db:studio` (Opens Prisma Studio at port 5555).

## 6. Key Concepts for AI Developers
When modifying this codebase or adding new features, keep the following in mind:

1. **Strict Multi-Tenancy**: Every data point and device is tied to an `organizationId`. API endpoints must always enforce tenant isolation by requiring and filtering by `orgId`.
2. **Performance Considerations**: 
   - Never query PostgreSQL for "live" or "latest" device location. Always use the Redis `live_map:org:{orgId}` hash.
   - Database writes for telemetry are heavy; they must go through Kafka -> Data Processor -> Bulk Insert. Do not write telemetry directly from the Next.js API.
3. **Monorepo Conventions**: When adding database models, modify `packages/db/prisma/schema.prisma`. Then run `npm run db:generate` in the root to update the shared Prisma client.
4. **Environment Variables**: Environment variables are shared across apps using the root `.env` file. If a new service requires an env var, document it in `.env.example`.

## 7. Extending the Project (Examples for Future Prompts)
If you are planning future requirements with this AI, you can ask it to:
- "Add a new REST API endpoint in `web-dashboard` to calculate total distance traveled per vehicle using PostGIS functions in Prisma."
- "Implement a new background worker in `data-processor` to detect harsh braking based on incoming IO elements from Teltonika devices."
- "Modify the Go `tcp-server` to support a new GPS protocol (e.g., Ruptela or Coban)."
- "Add a new Prisma model in `packages/db` for 'Drivers' and link it to 'Vehicles', then generate the migrations."
