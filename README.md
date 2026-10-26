# Fleet Vision Enterprise Platform — Backend & Telematics Monorepo

[![Turborepo](https://img.shields.io/badge/Turborepo-2.5.0-ef4444?style=flat-square&logo=turborepo)](https://turbo.build/)
[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)](https://go.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Kafka](https://img.shields.io/badge/Apache_Kafka-KRaft_/_MSK-231F20?style=flat-square&logo=apachekafka)](https://kafka.apache.org/)
[![TimescaleDB](https://img.shields.io/badge/TimescaleDB-PostgreSQL_15-FDB515?style=flat-square&logo=postgresql)](https://www.timescale.com/)
[![Redis](https://img.shields.io/badge/Redis-In--Memory_State-DC382D?style=flat-square&logo=redis)](https://redis.io/)
[![Next.js](https://img.shields.io/badge/Next.js-15.3-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![Prisma](https://img.shields.io/badge/Prisma-6.x-2D3748?style=flat-square&logo=prisma)](https://www.prisma.io/)

Welcome to the **Fleet Vision Enterprise Platform** backend repository (`fleet-vision`). This monorepo powers a multi-tenant, BYOD (Bring Your Own Device) IoT telematics engine. It ingests high-frequency binary AVL telemetry from vehicle-mounted hardware tracking units (Teltonika Codec 8/8E) over TCP, authenticates devices against tenant workspaces in Redis, streams events through Apache Kafka, performs spatial and batch writes to TimescaleDB (PostgreSQL 15 + PostGIS), and exposes low-latency Control Plane and Data Plane REST/SSE APIs.

---

## 📑 Table of Contents

- [1. System Architecture & Component Topology](#1-system-architecture--component-topology)
- [2. Engineering Lifecycle & SDLC Documentation](#2-engineering-lifecycle--sdlc-documentation)
  - [2.1 How Features are Received, Clarified, and Prioritized](#21-how-features-are-received-clarified-and-prioritized)
  - [2.2 Development, Code Repositories, Version Control, and Code Review](#22-development-code-repositories-version-control-and-code-review)
  - [2.3 Testing, Staging Environments, and Quality Approvals](#23-testing-staging-environments-and-quality-approvals)
  - [2.4 Build, Deployment, and Release Engineering (Tools & RACI)](#24-build-deployment-and-release-engineering-tools--raci)
  - [2.5 Post-Release Monitoring, Observability, and Rollback Procedures](#25-post-release-monitoring-observability-and-rollback-procedures)
- [3. Monorepo Structure & Package Details](#3-monorepo-structure--package-details)
- [4. Environment Variables & Configuration](#4-environment-variables--configuration)
- [5. Getting Started & Local Development](#5-getting-started--local-development)
- [6. Operations, CLI Runbook, and Database Management](#6-operations-cli-runbook-and-database-management)
- [7. Hardware Tracker Setup (Teltonika Codec 8/8E)](#7-hardware-tracker-setup-teltonika-codec-88e)
- [8. Critical Architectural Principles for Developers](#8-critical-architectural-principles-for-developers)

---

## 1. System Architecture & Component Topology

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              FLEET VISION ENTERPRISE BACKEND                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   ┌──────────────┐   TCP Binary AVL    ┌──────────────────┐   JSON Event  ┌──────────┐ │
│   │  Teltonika   ├────────────────────►│  TCP Gateway     ├──────────────►│  Kafka   │ │
│   │  GPS Device  │     Port 8500       │  (Go 1.23)       │               │ (KRaft/  │ │
│   └──────────────┘                     └──────────────────┘               │  MSK)    │ │
│                                                                           └────┬─────┘ │
│                                                                                │       │
│                                                                           eachBatch    │
│                                                                                ▼       │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│   │                         DATA PROCESSOR (Node.js 20)                             │  │
│   │                                                                                 │  │
│   │  1. Extract 15-digit IMEI from raw message                                      │  │
│   │  2. Cache-aside Auth: HGETALL auth:{imei} (Redis) -> Fallback to PostgreSQL     │  │
│   │  3. Multi-Tenant Enforcement: Drop unauthorized packets; inject organizationId │  │
│   │  4. Piecewise Fuel Calibration: Linear interpolation on BLE fuel sensor raw mV │  │
│   │  5. Real-Time HUD State: HSET live_map:org:{orgId} {coords, speed, ignition}    │  │
│   │  6. Batch Writer: Bulk INSERT into TimescaleDB telemetry_records hypertable     │  │
│   │  7. Workers: PostGIS Geofence Evaluation & Cold Storage Parquet Archival        │  │
│   └──────────────────────┬──────────────────────────────────┬───────────────────────┘  │
│                          │                                  │                          │
│                          ▼                                  ▼                          │
│               ┌──────────────────────┐           ┌──────────────────────┐              │
│               │   Redis (In-Memory)  │           │ TimescaleDB / PostGIS│              │
│               │  • auth:{imei}       │           │  • Relational DB     │              │
│               │  • live_map:org:{id} │           │  • Spatial Polygons  │              │
│               │  • SSE Broadcast     │           │  • Hypertable Chunks │              │
│               └──────────┬───────────┘           └──────────┬───────────┘              │
│                          │                                  │                          │
│                          ▼                                  ▼                          │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│   │                     CONTROL & DATA PLANE APIS (Next.js 15)                      │  │
│   │                                                                                 │  │
│   │  Control Plane:                          Data Plane:                            │  │
│   │  • POST /api/v1/auth/login               • GET /api/v1/live-locations           │  │
│   │  • POST /api/v1/organizations            • GET /api/v1/history (PostGIS Replay) │  │
│   │  • POST /api/v1/devices                  • GET /api/v1/events/stream (SSE)      │  │
│   │  • POST /api/v1/devices/:id/assign       • GET /api/v1/fuel-analytics           │  │
│   │  • POST /api/v1/vehicles                 • GET /api/v1/utilization-report       │  │
│   │  • GET/POST /api/v1/organizations/api-key • GET /doc (Interactive Swagger UI)  │  │
│   └─────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Engineering Lifecycle & SDLC Documentation

### 2.1 How Features are Received, Clarified, and Prioritized

```mermaid
flowchart TD
    A[Feature Intake Sources<br/>Hardware Vendors, Fleet Clients, SLAs] --> B[Technical Clarification & RFC<br/>Hardware Protocol & Schema Design]
    B --> C[RICE Scoring & Prioritization<br/>Impact vs Engineering Feasibility]
    C --> D{Sprint Planning Decision}
    D -- P0 / P1 --> E[Assigned to Sprint Backlog<br/>Jira / Linear Epics]
    D -- P2 / P3 --> F[Refined for Future Milestones]
```

#### 1. Intake Channels
New feature requests and platform enhancements enter the Fleet Vision backend ecosystem through four defined channels:
- **Hardware Integration Inquiries**: Requests to support new tracker models (e.g., Teltonika FMB920, FMC130, Ruptela, Coban) or specialized peripherals (Bluetooth Low Energy fuel level sensors, temperature probes, iButton/RFID driver keys).
- **Enterprise Fleet Requirements**: Requests from logistics and transport operators for advanced reporting, geofence trigger logic, fuel drain detection algorithms, and cold-chain compliance.
- **Platform Infrastructure SLAs**: Engineering-driven requirements regarding telemetry ingestion throughput, Kafka broker scaling, database compression policies, and sub-second API latency.
- **Security & Regulatory Compliance**: Multi-tenancy isolation policies, API key rotation standards, and audit logging mandates.

#### 2. Clarification & RFC Process
Before writing code, features undergo formal technical clarification:
- **Hardware Protocol Specification**: For telematics inputs, engineers inspect hex payloads, endianness, AVL record formats, and IO property IDs according to official manufacturer protocol specs (e.g., Teltonika Codec 8 / Codec 8 Extended).
- **Architecture RFC (Request for Comments)**: A technical design document is prepared covering:
  - Database schema changes in `packages/db/prisma/schema.prisma`.
  - Impact on Kafka message schemas (`telemetry-raw`).
  - Redis data structures and memory footprint impact.
  - Multi-tenant isolation guarantees (`organizationId` validation).
- **API Contract Review**: Endpoints are drafted in OpenAPI 3.0 specification (`/api/openapi.json`), establishing input validation rules, error codes, and responses.

#### 3. Prioritization Framework (RICE Matrix)
Features are scored using the **RICE** methodology (Reach, Impact, Confidence, Effort) and categorized into clear priority tiers:

| Tier | Priority Category | Description & Criteria | Examples in Fleet Vision |
| :--- | :--- | :--- | :--- |
| **P0** | **Critical Blocker** | Ingestion pipeline failure, data loss, security vulnerability, tenant isolation breach. | TCP connection drops, unindexed telemetry ingestion, Kafka consumer deadlock. |
| **P1** | **Core Business** | Direct business requirement for fleet operations, enterprise customer deliverables. | Piecewise fuel calibration, real-time geofence violation alerts, SSE stream reconnection. |
| **P2** | **Analytical Enhancement**| Optimization of reporting, automated archival, advanced filtering. | Parquet cold-storage pipeline, trip track downsampling, vehicle utilization aggregation. |
| **P3** | **Internal & Polish** | Developer tooling, Swagger doc refinements, non-critical telemetry metrics. | Extended IO debug logging, internal CLI utilities, test fixtures. |

#### 4. Stakeholder Ownership
- **Product Manager (PM)**: Gathers commercial customer requirements and defines acceptance criteria.
- **Hardware & Telematics Lead**: Validates sensor accuracy, binary packet framing, and tracker configurator profiles.
- **Principal Backend Architect**: Approves database schema migrations, Kafka partitioning, and tenancy isolation models.

---

### 2.2 Development, Code Repositories, Version Control, and Code Review

```mermaid
gitGraph
    commit id: "v1.1.0"
    branch feat/fuel-sensor
    checkout feat/fuel-sensor
    commit id: "add BLE parser"
    commit id: "piecewise calibration"
    checkout main
    merge feat/fuel-sensor id: "PR #42 (Squash & Merge)"
    commit id: "v1.2.0 Tag"
```

#### 1. Repository Structure & Workspace
The backend is maintained in a single monorepo:
- **Repository URL**: `https://github.com/developer-alluvium/fleet-vision.git`
- **Monorepo Engine**: **Turborepo** (`turbo.json`) with **npm workspaces**.
- **Applications**:
  - `apps/tcp-server`: High-throughput Go 1.23 ingestion gateway (Port 8500).
  - `apps/data-processor`: Node.js 20 Kafka consumer worker and background jobs.
  - `apps/web-dashboard`: Next.js 15 REST and SSE API server (Port 3000).
- **Shared Packages**:
  - `packages/db`: Shared Prisma 6 ORM client, relational schema, and Redis connection singleton.

#### 2. Branching Strategy & Git Workflow
Fleet Vision follows **Trunk-Based Development with Short-Lived Feature Branches**:
- `main`: Always releasable, production-ready branch. Direct pushes to `main` are strictly blocked via GitHub branch protection rules.
- `feat/<feature-name>`: Dedicated branches for new features (e.g., `feat/fuel-sensor`, `feat/aws-msk-iam`).
- `fix/<bug-name>`: Dedicated branches for bug fixes (e.g., `fix/tcp-packet-cap`, `fix/redis-auth-fallback`).
- `chore/<task-name>`: Dependency updates, CI/CD adjustments, refactoring.

#### 3. Commit Message Standards
Commits must follow the **Conventional Commits** specification:
- `feat(tcp-server): add support for Teltonika Codec 8 Extended AVL records`
- `fix(data-processor): prevent memory leak during bulk insertion into TimescaleDB`
- `perf(db): add composite spatial index on geofence coordinates`
- `refactor(api): standardize error payload format across auth routes`

#### 4. Development Standards & Tooling
- **Go (`apps/tcp-server`)**: Standard `gofmt`, `go vet`, and staticcheck. Goroutines must adhere to strict context cancellation to prevent goroutine leaks.
- **TypeScript (`apps/data-processor`, `apps/web-dashboard`, `packages/db`)**: Strict TypeScript configuration (`strict: true`, `noImplicitAny: true`). Linting enforced via ESLint 9.
- **Database Schema**: All model updates reside in `packages/db/prisma/schema.prisma`. Developers run `npm run db:generate` to refresh typed clients across the monorepo.

#### 5. Code Review & Pull Request Gates
Every pull request requires:
1. **At least 1 Senior Backend Engineer approval**.
2. **Mandatory PR Review Checklist**:
   - [ ] Multi-tenancy check: Does every database query enforce `organizationId` filtering?
   - [ ] High-throughput check: Are heavy database writes offloaded to Kafka / bulk batch queues?
   - [ ] Cache consistency: Does device registration update or invalidate the corresponding Redis `auth:{imei}` key?
   - [ ] Zero-downtime migration: Are Prisma schema modifications backwards-compatible with running services?
   - [ ] Error handling: Are binary parsing errors handled without crashing the TCP listener loop?

---

### 2.3 Testing, Staging Environments, and Quality Approvals

```mermaid
flowchart LR
    A[Unit & Parser Tests<br/>Go Codec8, TS Utils] --> B[Integration Testing<br/>TCP -> Kafka -> DB Pipeline]
    B --> C[Hardware Simulation<br/>Simulated AVL GPS Stream]
    C --> D[Staging Deployment<br/>AWS Staging VPC]
    D --> E[QA Sign-Off<br/>Master QA Checklist]
    E --> F[Production Release]
```

#### 1. Testing Pyramid & Verification Levels
Testing is executed across four distinct tiers as detailed in [TESTING.md](file:///home/yash/Desktop/projects/fleet-vision/TESTING.md):
- **Unit Testing**:
  - Binary framing tests in Go verifying CRC-16 ARC checksum calculation and Codec 8 / 8E packet decoding (`apps/tcp-server/parser/codec8_test.go`).
  - Unit tests for piecewise linear fuel interpolation and geofence ray-casting algorithms.
- **Integration Testing**:
  - Telematics Pipeline Tests: Sending mock AVL packets over a live TCP socket, verifying message delivery to Kafka topic `telemetry-raw`, consumption by `data-processor`, and insertion into PostgreSQL / TimescaleDB.
  - Multi-Tenant Security Tests: Verifying that devices belonging to Organization A cannot emit telemetry or be read under Organization B.
- **Hardware & Load Simulation**:
  - Custom socket scripts simulate 500+ Teltonika devices transmitting concurrent GPS bursts, testing socket buffer management and Kafka consumer group throughput.
- **API Contract & Swagger Testing**:
  - Automated tests validating all endpoints against `/api/openapi.json` schemas.
  - Interactive validation via Swagger UI at `/doc`.

#### 2. Staging Environment
- **Infrastructure**: An isolated AWS EC2 staging environment mirroring production topology:
  - Containerized `fv-timescaledb-staging`, `fv-backend-api-staging`, `fv-data-processor-staging`, and `fv-tcp-server-staging`.
  - Staging Redis and Kafka clusters.
- **Physical Device Whitelist**: Designated physical test trackers (IMEIs: `868204050001001`, `868204050002002`) are configured in the Teltonika Configurator to stream live telemetry to the staging TCP endpoint.

#### 3. Quality Sign-Off Criteria
Before any deployment to production, the QA team and Tech Leads must approve the release against the **QA Sign-Off Checklist**:
- Zero P0 or P1 open defects.
- Swagger UI `/doc` passes 100% of functional test cases.
- Ingestion pipeline demonstrates 0% packet drop rate for authorized devices.
- Kafka consumer group lag remains near zero under simulated peak load.
- Memory usage across Go TCP server and Node.js processor remains stable without leaks.

---

### 2.4 Build, Deployment, and Release Engineering (Tools & RACI)

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Backend Engineer
    participant Git as GitHub (main)
    participant Build as Docker Multi-Stage Build
    participant Reg as Docker Hub Registry
    participant EC2 as AWS EC2 Host
    participant DB as AWS RDS & TimescaleDB

    Dev->>Git: Merges approved PR to main
    Git->>Build: Trigger production image builds
    Build->>Reg: Push punit084/gps:backend-api, data-processor, tcp-server
    Dev->>DB: Execute migrations (npm run db:push & db:push:timescale)
    Dev->>EC2: Pull latest images & restart containers (npm run docker:prod:up)
    EC2->>EC2: Docker Healthchecks verify /api/health & TCP 8501
    EC2-->>Dev: Deployment Successful (Healthy)
```

#### 1. Tooling Stack
- **Containerization**: Docker & Docker Compose (`docker-compose.yml`, `docker-compose.prod.yml`).
- **Monorepo Build Engine**: Turborepo (`turbo run build`).
- **Container Registry**: Docker Hub (`punit084/gps:*`).
- **Target Infrastructure**: AWS EC2 instance (Ubuntu 22.04 LTS), AWS RDS PostgreSQL, AWS ElastiCache (Redis), AWS MSK Serverless / Kafka, Persistent TimescaleDB on host volume (`/opt/timescaledb/data`).

#### 2. Step-by-Step Production Release Workflow

##### Step 1: Pre-Deployment Build & Verification
1. Checkout the latest `main` branch.
2. Build all production Docker images:
   ```bash
   npm run docker:prod:build
   ```
3. Push images to the container registry:
   ```bash
   npm run docker:prod:push
   ```

##### Step 2: Database Migration Execution
Apply schema updates safely before rolling new application code:
1. Push relational schema changes to AWS RDS:
   ```bash
   npm run db:push
   ```
2. Initialize or migrate TimescaleDB hypertables:
   ```bash
   npm run db:push:timescale
   ```
3. Verify hypertable status:
   ```bash
   docker exec fv-timescaledb psql -U postgres -d fleet_vision \
     -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
   ```

##### Step 3: Container Deployment on Production Host
On the production EC2 host:
1. Ensure `.env.production` is configured and permissions are secure (`chmod 600 .env.production`).
2. Pull latest containers and start services with healthchecks enabled:
   ```bash
   npm run docker:prod:up
   ```
3. Confirm container health:
   ```bash
   docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml ps
   ```

##### Step 4: Post-Deployment Smoke Verification
1. Inspect container logs for boot errors:
   ```bash
   npm run docker:prod:logs
   ```
2. Verify API healthcheck endpoint:
   ```bash
   curl -I http://localhost:3000/api/health
   ```
3. Verify Go TCP Gateway health probe:
   ```bash
   curl -I http://localhost:8501/healthz
   ```

#### 3. RACI Matrix (Roles & Responsibilities)

| Release Step | Backend Engineer | DevOps / Infra Lead | QA Lead | Product Manager |
| :--- | :---: | :---: | :---: | :---: |
| **Feature Implementation & PR** | **R** (Responsible) | **C** (Consulted) | **I** (Informed) | **I** (Informed) |
| **Database Migrations** | **R** / **A** | **C** | **I** | **I** |
| **Docker Image Build & Push** | **C** | **R** / **A** | **I** | **I** |
| **Staging Deployment & Sign-Off** | **S** (Support) | **R** | **A** (Approver) | **C** |
| **Production Rollout** | **S** | **R** / **A** | **C** | **I** |
| **Post-Deploy Smoke Test** | **C** | **C** | **R** / **A** | **I** |
| **Rollback Execution (if needed)**| **R** | **A** | **C** | **I** |

---

### 2.5 Post-Release Monitoring, Observability, and Rollback Procedures

```mermaid
flowchart TD
    A[Production Ingestion Active] --> B{Continuous Monitoring}
    B -->|Check 1| C[API Health /api/health == 200]
    B -->|Check 2| D[TCP Server Port 8501 == OK]
    B -->|Check 3| E[Kafka Consumer Lag < 500 msgs]
    B -->|Check 4| F[TimescaleDB Disk & CPU < 75%]
    
    C & D & E & F -->|Healthy| G[Normal Operations]
    
    C & D & E & F -->|Failure / Spike Detected| H[Trigger P0 Alert]
    H --> I{Triage Severity}
    I -- Critical Defect --> J[Execute Rollback Procedure]
    I -- Config Issue --> K[Apply Hotfix & Restart Services]
```

#### 1. Production Health Probes & Metrics
Post-release system stability is monitored across five core operational vectors:
- **API Gateway Health**: Automated periodic HTTP probes to `http://localhost:3000/api/health`. Expected response: HTTP 200 `{ "status": "ok" }`.
- **TCP Gateway Liveness**: Native HTTP health endpoint in the Go server on port 8501 (`GET /healthz`), ensuring the socket listener on port 8500 is accepting connections without deadlocks.
- **Kafka Consumer Group Lag**: Monitored via Kafka CLI or Prometheus JMX exporter:
  ```bash
  kafka-consumer-groups.sh --bootstrap-server $KAFKA_BROKERS --describe --group data-processor-group
  ```
  A growing lag indicates the Node.js batch processor is falling behind ingestion volume.
- **Database Hypertable & Storage Health**:
  - Monitoring table bloat and compression ratios on `telemetry_records`.
  - Checking disk space on `/opt/timescaledb/data` to ensure host storage does not exceed 80% capacity.
- **Redis State & Memory**:
  - Monitoring memory consumption of `live_map:org:*` hashes and ensuring key eviction policies (`noeviction` for persistent maps) do not trigger out-of-memory panics.

#### 2. Rollback Procedures

If a critical issue occurs post-release (e.g., memory leak, unhandled tracker exception, database deadlocks), the following rollback steps are executed immediately:

##### Step 1: Revert Application Containers
Re-point Docker Compose to the previous stable image tags:
```bash
# 1. Update image tags in docker-compose.prod.yml or export PREVIOUS_TAG
export IMAGE_TAG=v1.1.0

# 2. Recreate containers with previous stable images
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

##### Step 2: Kafka Consumer Group Recovery
If bad payloads caused processing failures or message unacknowledged crashes:
```bash
# Reset consumer group offset to the last known committed offset or by time:
kafka-consumer-groups.sh --bootstrap-server $KAFKA_BROKERS \
  --group data-processor-group \
  --reset-offsets --to-offset <SAFE_OFFSET> \
  --topic telemetry-raw --execute
```

##### Step 3: Database Migration Rollback
If a Prisma migration caused relational lockups:
- Revert schema changes using pre-tested backward SQL migration scripts.
- Reload previous database snapshot from AWS RDS Automated Snapshots if data integrity is compromised.

##### Step 4: Incident Retrospective & Post-Mortem
Within 24 hours of an incident:
- Convene a blameless post-mortem meeting with the engineering team.
- Document root cause analysis (RCA), timeline of events, and detection lag.
- Create automated test cases in `TESTING.md` to prevent identical regressions.

---

## 3. Monorepo Structure & Package Details

```text
fleet-vision/
├── apps/
│   ├── tcp-server/                   # High-concurrency Go 1.23 TCP Gateway
│   │   ├── main.go                   # TCP listener & graceful shutdown
│   │   ├── handler.go                # Socket connection lifecycle & framing
│   │   ├── parser/
│   │   │   ├── codec8.go             # Codec 8 & Codec 8 Extended binary parser
│   │   │   └── crc16.go              # CRC-16 ARC validation
│   │   ├── producer.go               # Kafka producer with MSK/SASL/IAM support
│   │   └── Dockerfile                # Multi-stage Go scratch/alpine build
│   │
│   ├── data-processor/               # Node.js 20 Telematics Ingestion Engine
│   │   ├── src/
│   │   │   ├── index.ts              # Worker entry point
│   │   │   ├── consumer.ts           # Kafka batch consumer (eachBatch)
│   │   │   ├── auth.ts               # Redis cache-aside device authenticator
│   │   │   ├── telemetry-writer.ts   # Bulk batch inserter for TimescaleDB
│   │   │   ├── fuel-calibration.ts   # Piecewise linear interpolation
│   │   │   └── workers/              # Geofence & Cold storage background jobs
│   │   └── Dockerfile                # Node.js Alpine container build
│   │
│   └── web-dashboard/                # Next.js 15 App Router Backend API
│       ├── app/                      # REST API routes (/api/v1/...) & /doc Swagger
│       ├── lib/                      # JWT auth, HttpOnly cookies, route handlers
│       └── Dockerfile                # Standalone Next.js production build
│
├── packages/
│   └── db/                           # Shared Database Layer
│       ├── prisma/
│       │   └── schema.prisma         # Multi-tenant PostgreSQL relational schema
│       └── src/
│           ├── index.ts              # PrismaClient singleton export
│           └── redis.ts              # Redis client singleton export
│
├── docker-compose.yml                # Base application container definitions
├── docker-compose.infra.yml          # Local infra (TimescaleDB, Redis, Kafka)
├── docker-compose.prod.yml           # Production EC2 overrides & resource limits
├── package.json                      # Monorepo root configuration & npm workspaces
└── turbo.json                        # Turborepo task pipeline caching configuration
```

---

## 4. Environment Variables & Configuration

A template configuration is provided in `.env.example` (local development) and `.env.production.example` (AWS EC2 production).

| Variable Name | Environment | Description | Example / Default |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Local / Prod | PostgreSQL connection string for Prisma ORM | `postgresql://user:pass@rds-host:5432/fleet_vision` |
| `TIMESCALE_URL` | Local / Prod | TimescaleDB connection string for hypertable | `postgresql://postgres:pass@timescaledb:5432/fleet_vision` |
| `REDIS_URL` | Local / Prod | Redis connection URL for live map and auth | `redis://localhost:6379` |
| `KAFKA_BROKERS` | Local / Prod | Comma-separated Kafka broker addresses | `localhost:9092` or `b-1.msk.aws:9092` |
| `KAFKA_TOPIC` | Local / Prod | Topic for raw telemetry events | `telemetry-raw` |
| `CONSUMER_GROUP` | Local / Prod | Kafka consumer group name | `data-processor-group` |
| `JWT_SECRET` | Local / Prod | Secret key for signing 15-minute access JWTs | `64-character-hex-random-string` |
| `TCP_PORT` | Local / Prod | Port for Teltonika GPS tracker connections | `8500` |
| `HEALTH_PORT` | Local / Prod | Port for Go TCP server HTTP health probe | `8501` |
| `KAFKA_USE_TLS` | Prod | Enable TLS encryption for AWS MSK | `true` |
| `KAFKA_SASL_MECHANISM`| Prod | SASL mechanism (e.g., AWS_MSK_IAM, SCRAM) | `AWS_MSK_IAM` |

---

## 5. Getting Started & Local Development

### 1. Prerequisites
- **Node.js**: `v20.x` or later
- **Docker & Docker Compose**: Installed and running
- **Go**: `v1.23` (if building the TCP Gateway binary locally)

### 2. Installation
Clone the repository and install all workspace dependencies:
```bash
git clone https://github.com/developer-alluvium/fleet-vision.git
cd fleet-vision
npm install
```

### 3. Start Local Infrastructure
Boot TimescaleDB (PostgreSQL 15 + PostGIS), Redis, and Apache Kafka (KRaft mode):
```bash
npm run infra:up
```

Verify that all three infrastructure containers are healthy:
```bash
docker compose -f docker-compose.yml -f docker-compose.infra.yml ps
```

### 4. Initialize Database Schema
Push the Prisma schema to create application tables:
```bash
npm run db:push
```

Initialize the TimescaleDB hypertable for telemetry records:
```bash
docker exec fv-postgres psql -U postgres -d fleet_vision \
  -f /docker-entrypoint-initdb.d/010-init-timescaledb.sql
```

### 5. Start Development Services
Run all backend applications concurrently:
```bash
npm run dev:all
```
This launches:
- **Web Dashboard / APIs (Next.js)** on [http://localhost:3000](http://localhost:3000) (Interactive Swagger Docs at [http://localhost:3000/doc](http://localhost:3000/doc)).
- **TCP Gateway (Go)** listening on TCP port `8500` and health probe on port `8501`.
- **Data Processor (Node.js)** consuming from Kafka topic `telemetry-raw`.

---

## 6. Operations, CLI Runbook, and Database Management

| Command | Category | Description |
| :--- | :--- | :--- |
| `npm run dev:all` | **Dev** | Concurrently runs Next.js API, Go TCP Server, and Data Processor |
| `npm run dev:tcp` | **Dev** | Runs only the Go TCP Server on port 8500 |
| `npm run dev:processor` | **Dev** | Runs only the Node.js Data Processor Kafka consumer |
| `npm run dev:dashboard` | **Dev** | Runs only the Next.js API server on port 3000 |
| `npm run infra:up` | **Infra** | Starts TimescaleDB, Redis, and Kafka in background |
| `npm run infra:down` | **Infra** | Gracefully shuts down local infrastructure containers |
| `npm run infra:logs` | **Infra** | Streams logs for Postgres, Redis, and Kafka |
| `npm run infra:clean` | **Infra** | Destroys infrastructure containers and wipes all local Docker volumes |
| `npm run db:generate` | **Database**| Rebuilds the Prisma Client singleton in `@fleet-vision/db` |
| `npm run db:push` | **Database**| Pushes `packages/db/prisma/schema.prisma` directly to active database |
| `npm run db:push:timescale` | **Database**| Pushes schema to TimescaleDB port 5433 and initializes hypertable |
| `npm run db:studio` | **Database**| Launches Prisma Studio web GUI on [http://localhost:5555](http://localhost:5555) |
| `npm run docker:prod:build` | **Release** | Compiles production Docker images for all services |
| `npm run docker:prod:up` | **Release** | Launches production stack on EC2 with `.env.production` |
| `npm run docker:prod:down` | **Release** | Stops production containers |
| `npm run docker:prod:logs` | **Release** | Streams consolidated production container logs |

---

## 7. Hardware Tracker Setup (Teltonika Codec 8/8E)

To connect a real Teltonika tracking unit (e.g., FMB920, FMC130, FMM130) to the platform:

1. Connect the device to your PC using a USB cable and launch the **Teltonika Configurator**.
2. Navigate to **GPRS → Server Settings**:
   - **Server Domain / IP**: Your server's public IP or domain (e.g., `api.fleetvision.alvision.in`).
   - **Server Port**: `8500`
   - **Protocol**: `TCP`
3. Navigate to **Data Acquisition**:
   - Set **Min Period** to `10s` (On Moving) and `60s` (On Stop).
   - Ensure **Send Data With** is set to `Always`.
4. Navigate to **System → Data Protocol**:
   - Select **Codec 8** or **Codec 8 Extended**.
5. Save configuration to device.

> **CRITICAL SECURITY REQUIREMENT**: The device's 15-digit IMEI number must be registered via the Control Plane API (`POST /api/v1/devices`) or through the Client Dashboard before turning on the device. When the device connects, the Data Processor verifies the IMEI against Redis cache (`auth:{imei}`). Unregistered IMEIs are dropped immediately to enforce tenant security.

---

## 8. Critical Architectural Principles for Developers

1. **Strict Multi-Tenancy Enforcement**:
   - Every single SQL and Prisma query must filter by `organizationId`. Never return data across tenant boundaries.
2. **Read vs. Write Path Segregation**:
   - **Live Vehicle Positions**: NEVER query PostgreSQL or TimescaleDB for "latest" or "live" vehicle coordinates. Always read from the Redis hash `live_map:org:{orgId}`.
   - **Historical Ingestion**: NEVER write incoming GPS telemetry directly from HTTP API endpoints. All high-throughput telemetry writes must follow the path: `TCP Server -> Kafka -> Data Processor -> TimescaleDB Bulk Batch`.
3. **Database Schema Migrations**:
   - Never edit generated migrations by hand. Always modify `packages/db/prisma/schema.prisma`, run `npm run db:generate`, and verify compatibility against TimescaleDB hypertables.
4. **Resilient TCP Concurrency**:
   - In Go, never allocate unbounded buffers inside client connection loops. Keep AVL packet reads bounded and validate CRC-16 checksums before acknowledging payloads.

---

<p align="center">
  <i>Fleet Vision Enterprise Platform Documentation &copy; 2026. Maintained by the Fleet Vision Core Engineering Team.</i>
</p>
