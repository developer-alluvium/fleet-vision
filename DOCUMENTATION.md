# Fleet Vision — Complete Project Documentation

> **Fleet Vision** is a real-time **vehicle/fleet tracking platform** that receives GPS telemetry from **Teltonika FMC130** (or similar) tracking devices installed in vehicles, processes the data, stores it in a database, and displays it on a web dashboard.

---

## Table of Contents

1. [What Does Each Folder Do?](#1-what-does-each-folder-do)
2. [How To Run The Project](#2-how-to-run-the-project)
3. [How To Check Live Data From Your Office Devices](#3-how-to-check-live-data-from-your-office-devices)
4. [What Details You Get From Devices](#4-what-details-you-get-from-devices)
5. [Complete File Structure Explained](#5-complete-file-structure-explained)
6. [Go Language File Structure Explained (For Beginners)](#6-go-language-file-structure-explained-for-beginners)
7. [What Is The Use Of Kafka Here?](#7-what-is-the-use-of-kafka-here)

---

## 1. What Does Each Folder Do?

### 📡 `apps/tcp-server/` — The TCP Gateway (Written in Go)

**Purpose:** This is the **first point of contact** for your tracking devices. It is a raw TCP server (NOT an HTTP server).

**How it works:**
1. Your Teltonika FMC130 device (installed in a vehicle) opens a **TCP connection** to this server on **port 8500**.
2. The device sends its **IMEI number** (a 15-digit unique ID) as a handshake.
3. The server validates the IMEI and replies with an acceptance byte (`0x01`).
4. The device then starts sending **binary GPS data packets** (using Teltonika's "Codec 8" protocol).
5. The server **parses the binary data** (latitude, longitude, speed, altitude, etc.) and converts it to JSON.
6. The JSON is then **published to Kafka** (a message queue) on the `telemetry-raw` topic.
7. Only after Kafka confirms the message is stored, the server sends an **ACK (acknowledgement)** back to the device.

**In simple terms:** This is the "listener" — it talks to your GPS hardware and puts the data into the pipeline.

---

### ⚙️ `apps/data-processor/` — The Data Processor (Written in TypeScript/Node.js)

**Purpose:** This is a **background worker** that reads messages from Kafka and saves them into the PostgreSQL database.

**How it works:**
1. It connects to **Kafka** as a consumer and subscribes to the `telemetry-raw` topic.
2. Whenever the TCP server pushes a new GPS message into Kafka, this processor **picks it up**.
3. It **upserts the Device** (creates a new device record if this IMEI has never been seen, or updates the `updatedAt` timestamp).
4. It **batch-inserts all TelemetryRecords** (GPS data points) into PostgreSQL in a single database transaction.
5. Logs the result: how many records were inserted for which IMEI.

**In simple terms:** This is the "saver" — it takes data from the pipeline and stores it permanently in the database.

---

### 🖥️ `apps/web-dashboard/` — The Web Dashboard (Written in Next.js/React)

**Purpose:** This is the **frontend web application** that you open in your browser to visualize the fleet data.

**How it works:**
- It's a **Next.js 15** app using the App Router with **Tailwind CSS v4** for styling.
- Currently shows a clean landing page with a "System Online" status badge.
- This is where you'll build out features like:
  - Live map showing vehicle positions
  - Vehicle trip history
  - Speed/altitude charts
  - Device management panel

**In simple terms:** This is the "viewer" — the visual dashboard you use to see all the tracking data.

---

### 📦 `packages/db/` — Shared Database Package

**Purpose:** Contains the **Prisma ORM schema** and a shared database client that other apps import.

**How it works:**
- Defines the database tables (`devices` and `telemetry_records`) in `prisma/schema.prisma`.
- Exports a singleton `PrismaClient` instance so both `data-processor` and `web-dashboard` can use the same database connection pattern.
- Any app that needs database access imports from `@fleet-vision/db`.

---

### 🔄 How They All Work Together (Data Flow)

```
┌──────────────┐     TCP/Binary     ┌──────────────┐      JSON       ┌─────────┐
│  FMC130 GPS  │ ──────────────────▶│  tcp-server  │ ──────────────▶ │  Kafka  │
│   Device     │   (Codec 8 data)   │  (Go, :8500) │  (publish msg)  │ (:9092) │
└──────────────┘                    └──────────────┘                 └────┬────┘
                                                                         │
                                                                    (consume)
                                                                         │
                                                                         ▼
┌──────────────┐                    ┌───────────────┐             ┌──────────────┐
│ web-dashboard│◀───── reads ──────▶│  PostgreSQL   │◀── writes ──│data-processor│
│  (Next.js)   │   from database    │   (:5432)     │             │  (Node.js)   │
│   :3000      │                    │  fleet_vision │             │              │
└──────────────┘                    └───────────────┘             └──────────────┘
```

---

## 2. How To Run The Project

### Prerequisites

Make sure you have these installed on your machine:

| Tool             | Version  | Download Link                                  |
| ---------------- | -------- | ---------------------------------------------- |
| **Node.js**      | v18+     | https://nodejs.org/                             |
| **Go**           | v1.21+   | https://go.dev/dl/                              |
| **Docker Desktop** | Latest | https://www.docker.com/products/docker-desktop/ |

### Step-by-Step

#### Step 1: Start Docker Desktop

Open Docker Desktop from the Start Menu. Wait until the icon in the system tray turns **green** (engine running). This is required because PostgreSQL and Kafka run as Docker containers.

#### Step 2: Install Dependencies

Open a terminal in the `fleet-vision` root folder:
```bash
npm install
```
This installs dependencies for **all workspaces** (web-dashboard, data-processor, and the shared db package).

#### Step 3: Set Up Environment Variables

Copy the example env file (if you haven't already):
```bash
copy .env.example .env
```

The `.env` file contains:
```env
# PostgreSQL connection string
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/fleet_vision?schema=public"

# Kafka broker address
KAFKA_BROKERS="localhost:9092"

# Kafka topic name for raw telemetry data
KAFKA_TOPIC="telemetry-raw"

# TCP port the Go server listens on
TCP_PORT="8500"
```

#### Step 4: Start Infrastructure (PostgreSQL + Kafka)

```bash
npm run infra:up
```

This runs `docker compose up -d` which starts:
- **fv-postgres** — PostgreSQL 16 database on port `5432`
- **fv-kafka** — Apache Kafka on port `9092` (KRaft mode, no ZooKeeper needed)

Verify they're running:
```bash
docker ps
```
You should see both `fv-postgres` and `fv-kafka` listed as **healthy**.

#### Step 5: Initialize the Database

```bash
npm run db:push
```

This uses Prisma to create the `devices` and `telemetry_records` tables in PostgreSQL.

#### Step 6: Start All 3 Services

**Option A — All in one terminal (quick start):**
```bash
npm run dev:all
```

**Option B — Separate terminals (recommended, easier to read logs):**

| Terminal | Command                  | What It Starts                     |
| -------- | ------------------------ | ---------------------------------- |
| 1        | `npm run dev:tcp`        | Go TCP Gateway on port `8500`      |
| 2        | `npm run dev:processor`  | Data Processor (Kafka consumer)    |
| 3        | `npm run dev:dashboard`  | Web Dashboard on `http://localhost:3000` |

### Useful Commands Reference

| Command              | What It Does                                    |
| -------------------- | ----------------------------------------------- |
| `npm run dev`        | Starts dashboard + data-processor only          |
| `npm run dev:all`    | Starts all 3 services (TCP + processor + dashboard) |
| `npm run dev:tcp`    | Starts only the Go TCP server                   |
| `npm run dev:processor` | Starts only the data processor              |
| `npm run dev:dashboard` | Starts only the Next.js dashboard            |
| `npm run infra:up`   | Starts Docker containers (Postgres + Kafka)     |
| `npm run infra:down` | Stops Docker containers                         |
| `npm run infra:logs` | Shows live logs from Docker containers          |
| `npm run db:push`    | Syncs Prisma schema to database                 |
| `npm run db:studio`  | Opens Prisma Studio (visual DB browser at `:5555`) |
| `npm run db:generate` | Regenerates Prisma client after schema changes |
| `npm run build`      | Builds all projects for production              |
| `npm run lint`       | Runs linting/type-checking on all projects      |

### Stopping Everything

1. Press `Ctrl+C` in each terminal to stop the services.
2. Stop Docker containers:
   ```bash
   npm run infra:down
   ```

---

## 3. How To Check Live Data From Your Office Devices

### Step 1: Find Your Computer's IP Address

Open a Command Prompt and run:
```cmd
ipconfig
```
Look for **IPv4 Address** under your active network adapter (Wi-Fi or Ethernet).  
Example: `192.168.1.50`

### Step 2: Configure the Teltonika FMC130 Device

1. Connect the FMC130 device to your computer via **USB cable**.
2. Open the **Teltonika Configurator** software.
3. Go to **GPRS → Server Settings**.
4. Set the following values:

| Setting      | Value                                    |
| ------------ | ---------------------------------------- |
| **Domain**   | Your computer's IP (e.g., `192.168.1.50`) |
| **Port**     | `8500`                                   |
| **Protocol** | `TCP`                                    |

5. Click **"Save to device"**.

### Step 3: Make Sure Everything Is Running

Ensure all 3 services are running (see [Step 6 above](#step-6-start-all-3-services)). The terminal running the TCP server should say:
```
[TCP] Listening on :8500 for Teltonika devices…
```

### Step 4: Watch Live Data Arrive

Once the FMC130 connects, you'll see real-time logs in the TCP server terminal:

```
[CONN] New connection from 192.168.1.100:54321
[CONN] 192.168.1.100:54321 identified as IMEI 352093089403706
[PARSE] 192.168.1.100:54321 (IMEI 352093089403706) parsed 4 records (codec=0x08)
[KAFKA] ✓ Published 1456 bytes (key=352093089403706)
[CONN] 192.168.1.100:54321 (IMEI 352093089403706) ACK sent for 4 records
```

And in the data-processor terminal:
```
[PROCESSOR] Processing 4 records from IMEI 352093089403706 (codec8)
[PROCESSOR] ✓ IMEI 352093089403706: upserted device clxyz..., inserted 4 records
```

### Step 5: View Data in Prisma Studio

Open a new terminal and run:
```bash
npm run db:studio
```
This opens a **visual database browser** at `http://localhost:5555`. You can click on:
- **devices** table → see all connected devices with their IMEI
- **telemetry_records** table → see all GPS data points with timestamps, coordinates, speed, etc.

### ⚠️ Important Networking Notes

| Scenario                          | What You Need                                    |
| --------------------------------- | ------------------------------------------------ |
| Device on **same Wi-Fi/LAN**      | Just use your local IP — works directly           |
| Device on **mobile data (4G/5G)** | You need **port forwarding** on your router (forward external port 8500 → your computer's IP:8500) |
| Device on a **different network** | Use port forwarding OR deploy to a cloud server with a public IP |

---

## 4. What Details You Get From Devices

### GPS Data (Every Record)

Every telemetry record from the FMC130 device contains:

| Field          | Type     | Description                                       | Example          |
| -------------- | -------- | ------------------------------------------------- | ---------------- |
| **timestamp**  | DateTime | When the GPS reading was taken by the device       | `2026-07-09T08:30:00Z` |
| **latitude**   | Float    | GPS latitude in degrees (× 10⁻⁷ precision)       | `19.0760`        |
| **longitude**  | Float    | GPS longitude in degrees (× 10⁻⁷ precision)      | `72.8777`        |
| **altitude**   | Int16    | Height above sea level in **meters**              | `14`             |
| **speed**      | UInt16   | Vehicle speed in **km/h**                         | `67`             |
| **angle**      | UInt16   | Direction of travel in **degrees** (0–360)        | `245`            |
| **satellites** | UInt8    | Number of GPS satellites in view                  | `12`             |
| **priority**   | UInt8    | Record priority (`0` = low/periodic, `1` = high, `2` = panic) | `0`  |

### IO Elements (Sensor & Vehicle Data)

In addition to GPS, each record includes **IO Elements** — these are sensor readings identified by numeric IDs. Common ones for the FMC130:

| IO ID | Name                    | Description                                    |
| ----- | ----------------------- | ---------------------------------------------- |
| `239` | Ignition                | `0` = OFF, `1` = ON                            |
| `240` | Movement                | `0` = stationary, `1` = moving                 |
| `21`  | GSM Signal              | Signal strength (1–5)                          |
| `200` | Sleep Mode              | `0` = no sleep, `1` = GPS sleep, `2` = deep sleep |
| `69`  | GNSS Status             | `0` = OFF, `1` = ON (no fix), `2` = ON (fix)   |
| `181` | GNSS PDOP               | Position dilution of precision                  |
| `182` | GNSS HDOP               | Horizontal dilution of precision                |
| `66`  | External Voltage        | Battery/power voltage in **mV**                |
| `67`  | Battery Voltage         | Internal battery voltage in **mV**              |
| `68`  | Battery Current         | Battery charging current in **mA**              |
| `16`  | Total Odometer          | Total distance traveled in **meters**           |
| `1`   | Digital Input 1 (DIN1)  | Digital input state                             |
| `9`   | Analog Input 1          | Analog sensor reading in **mV**                 |
| `113` | Battery Level           | Battery charge percentage (0–100%)              |
| `24`  | Speed (OBD)             | Speed from vehicle's OBD port (if connected)    |
| `205` | GSM Cell ID             | Currently connected cell tower ID               |
| `206` | GSM Area Code           | Location Area Code of cell tower                |

> **Note:** The exact IO elements you receive depend on how the device is configured in the Teltonika Configurator. You can enable/disable which sensors the device reports.

### Device Information

For each device, the database also stores:

| Field       | Description                              |
| ----------- | ---------------------------------------- |
| **id**      | Unique internal ID (auto-generated CUID) |
| **imei**    | 15-digit IMEI number (unique per device) |
| **createdAt** | When the device first connected         |
| **updatedAt** | Last time data was received             |

---

## 5. Complete File Structure Explained

```
fleet-vision/
│
├── .env                          # Environment variables (DB URL, Kafka config, TCP port)
├── .env.example                  # Template for .env (safe to commit to git)
├── .gitignore                    # Files/folders git should ignore
├── package.json                  # ROOT workspace config — defines workspaces + shared scripts
├── package-lock.json             # Locked dependency versions for reproducible installs
├── turbo.json                    # Turborepo pipeline config (build/dev/lint task definitions)
├── docker-compose.yml            # Docker config to run PostgreSQL + Kafka containers
├── README.md                     # Project overview and basic setup instructions
├── RUNBOOK.md                    # Detailed step-by-step guide to run the project
│
├── apps/                         # ── APPLICATION PROJECTS ──────────────────────
│   │
│   ├── tcp-server/               # ── GO TCP GATEWAY ───────────────────────────
│   │   ├── package.json          # npm wrapper — `npm run dev` calls `node dev.js`
│   │   ├── dev.js                # Node script that spawns `go run .` (for npm integration)
│   │   ├── go.mod                # Go module definition (like package.json for Go)
│   │   ├── go.sum                # Go dependency checksums (like package-lock.json for Go)
│   │   ├── main.go               # Entry point — starts TCP listener, loads env, accepts connections
│   │   ├── handler.go            # Connection lifecycle — IMEI handshake, packet reading, ACK
│   │   ├── producer.go           # Kafka producer — publishes parsed JSON to Kafka topic
│   │   └── parser/               # Sub-package for binary protocol parsing
│   │       ├── types.go          # Data structures: AVLRecord, TelemetryMessage, AVLPacket
│   │       └── codec8.go         # Teltonika Codec 8 / 8E binary parser + CRC-16 checksum
│   │
│   ├── data-processor/           # ── NODE.JS DATA PROCESSOR ──────────────────
│   │   ├── package.json          # Dependencies: kafkajs, @fleet-vision/db, dotenv
│   │   ├── tsconfig.json         # TypeScript compiler configuration
│   │   └── src/
│   │       ├── index.ts          # Entry point — connects to DB, starts Kafka consumer, shutdown
│   │       ├── consumer.ts       # Kafka consumer setup — subscribes to `telemetry-raw` topic
│   │       └── processor.ts      # Business logic — parses JSON, upserts device, inserts records
│   │
│   └── web-dashboard/            # ── NEXT.JS WEB DASHBOARD ───────────────────
│       ├── package.json          # Dependencies: next, react, tailwindcss
│       ├── next.config.mjs       # Next.js configuration
│       ├── postcss.config.cjs    # PostCSS config (used by Tailwind CSS v4)
│       ├── tsconfig.json         # TypeScript configuration
│       ├── next-env.d.ts         # Auto-generated Next.js type declarations
│       └── src/
│           └── app/              # Next.js App Router directory
│               ├── globals.css   # Global styles (Tailwind CSS imports)
│               ├── layout.tsx    # Root layout — HTML shell, dark background, metadata
│               └── page.tsx      # Home page — "Fleet Vision" heading + "System Online" badge
│
└── packages/                     # ── SHARED LIBRARIES ─────────────────────────
    └── db/                       # ── DATABASE PACKAGE (@fleet-vision/db) ─────
        ├── package.json          # Dependencies: @prisma/client, prisma, dotenv-cli
        ├── tsconfig.json         # TypeScript configuration
        ├── prisma/
        │   └── schema.prisma     # DATABASE SCHEMA — defines Device + TelemetryRecord tables
        └── src/
            └── index.ts          # Exports singleton PrismaClient + re-exports Prisma types
```

### What Is Each Config File For?

| File                 | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `package.json` (root)| Defines this as an **npm workspace monorepo**. Lists workspace paths (`apps/*`, `packages/*`) and shared scripts. |
| `turbo.json`         | Configures **Turborepo** — defines task pipeline (which tasks depend on which, what to cache). |
| `docker-compose.yml` | Defines the **Docker containers** for PostgreSQL and Kafka. Run with `npm run infra:up`. |
| `.env`               | **Environment variables** shared by all apps (database URL, Kafka address, TCP port). |
| `.gitignore`         | Tells Git to ignore `node_modules/`, `.next/`, `.env`, build outputs, Go binaries, etc. |

---

## 6. Go Language File Structure Explained (For Beginners)

Since you're new to Go, here's a beginner-friendly explanation of the Go files in `apps/tcp-server/`:

### How Go Projects Are Organized

| Concept            | Go Equivalent         | Node.js/TS Equivalent      |
| ------------------ | --------------------- | -------------------------- |
| Module definition  | `go.mod`              | `package.json`             |
| Dependency lock    | `go.sum`              | `package-lock.json`        |
| Package            | `package main`        | A folder with `index.ts`   |
| Entry point        | `func main()`         | The main script in `package.json` |
| Imports            | `import "fmt"`        | `import fs from "fs"`      |
| Exported function  | `func MyFunc()` (capitalized) | `export function myFunc()` |
| Private function   | `func myFunc()` (lowercase)  | Non-exported function      |

### `go.mod` — Module Definition (like `package.json`)

```go
module fleet-vision/tcp-server   // Module name (like "name" in package.json)

go 1.26.4                        // Go version

require github.com/segmentio/kafka-go v0.4.51   // External dependency
```

- **`module`** — declares the module name. Other files import sub-packages relative to this.
- **`require`** — lists dependencies (like `"dependencies"` in `package.json`).
- **`go.sum`** — auto-generated checksums for all dependencies (like `package-lock.json`). **Never edit this manually.**

### `main.go` — Entry Point (like `index.ts`)

```go
package main          // Every Go file declares which package it belongs to.
                      // "main" is special — it means this is an executable program.

import (              // Import standard library and external packages
    "fmt"             // Standard library: formatting/printing
    "log"             // Standard library: logging
    "net"             // Standard library: networking (TCP/UDP)
    "os"              // Standard library: OS operations (env vars, signals)
)

func main() {        // The entry point — Go always starts here.
    // Your code...
}
```

**Key things for beginners:**
- In Go, **every `.go` file in the same folder** must have the same `package` declaration.
- All `.go` files in the `tcp-server/` folder say `package main` — they're all part of the same executable.
- You **don't need to import other files** in the same package. Go automatically includes them.
  - For example, `main.go` can call `handleConnection()` which is defined in `handler.go` — no import needed!
- `func main()` is the program's entry point (like the main script in Node.js).

### `handler.go` — Connection Handler

This file handles each device connection. Key Go concepts:

```go
// Goroutine — Go's way of running things in parallel (like async in Node.js)
go handleConnection(conn, producer)   // "go" keyword launches a goroutine

// Defer — runs when the function returns (like "finally" in try/catch)
defer conn.Close()                    // Ensures the connection is closed when done

// Error handling — Go returns errors as values (no try/catch!)
imei, err := performIMEIHandshake(conn)
if err != nil {                       // Always check if err is not nil
    log.Printf("handshake failed: %v", err)
    return
}
```

**Why it looks different from TypeScript:**
- Go has **no classes**. It uses functions and structs.
- Go has **no `try/catch`**. Functions return `(result, error)` and you check the error.
- Go has **no `async/await`**. It uses **goroutines** (lightweight threads) with the `go` keyword.
- Go has **no generics** (in older versions). Types are explicit.

### `producer.go` — Kafka Producer

```go
// Struct — Go's version of a class (but with no inheritance)
type KafkaProducer struct {
    writer *kafka.Writer      // * means "pointer to" (reference type)
}

// Method — A function attached to a struct (like a class method)
func (p *KafkaProducer) Publish(ctx context.Context, key string, value []byte) error {
    // "p" is like "this" or "self"
    return p.writer.WriteMessages(ctx, msg)
}
```

### `parser/` — Sub-Package

The `parser/` folder is a **separate Go package**:

```go
package parser        // Different package name — not "main"
```

Files in `parser/` are imported by the main package:

```go
import "fleet-vision/tcp-server/parser"    // Import the sub-package

result, err := parser.ParseAVLPacket(data)  // Call an exported function
```

**Rule:** In Go, a function/type is **exported** (public) if its name starts with a **capital letter**:
- `ParseAVLPacket` → ✅ exported (other packages can call it)
- `parseAVLRecord` → ❌ unexported (only usable within the `parser` package)

### Summary: All Go Files and Their Purpose

| File                 | Package   | Purpose                                         |
| -------------------- | --------- | ------------------------------------------------ |
| `main.go`            | `main`    | Entry point: loads config, starts TCP listener, accepts connections |
| `handler.go`         | `main`    | Manages device lifecycle: IMEI handshake → data loop → ACK |
| `producer.go`        | `main`    | Kafka producer: publishes JSON messages to Kafka  |
| `parser/types.go`    | `parser`  | Data types: `AVLRecord`, `TelemetryMessage`, `AVLPacket` |
| `parser/codec8.go`   | `parser`  | Binary parser for Teltonika Codec 8/8E protocol + CRC check |

---

## 7. What Is The Use Of Kafka Here?

### The Problem Kafka Solves

Without Kafka, the architecture would look like:

```
Device → TCP Server → directly writes to PostgreSQL
```

**This has problems:**
1. **If the database is slow or down**, the TCP server would block, and devices would timeout and disconnect.
2. **If 500 devices send data simultaneously**, the TCP server would need 500 simultaneous DB connections.
3. **If the DB write fails**, the data is **lost forever**.

### How Kafka Fixes This

Kafka acts as a **buffer/queue** between the TCP server and the database:

```
Device → TCP Server → Kafka (buffer) → Data Processor → PostgreSQL
```

### Why This Architecture Is Better

| Benefit                  | Explanation |
| ------------------------ | ----------- |
| **Decoupling**           | The TCP server and database processor are **independent**. If the data-processor crashes, the TCP server keeps running and Kafka holds the messages safely. |
| **Reliability**          | Kafka **persists messages to disk**. Even if the data-processor is down for an hour, no data is lost — messages wait in the queue. |
| **Backpressure handling** | If 1000 devices send data at once, Kafka absorbs the burst. The data-processor consumes at its own pace. |
| **Scalability**          | You can run **multiple data-processor instances** consuming from the same Kafka topic to process data faster. |
| **Ordering guarantee**   | Messages are partitioned by **IMEI (device ID)**, so all data from one device is processed in order. |
| **Replay capability**    | If you need to reprocess data (e.g., after fixing a bug), you can reset the consumer offset and replay messages from Kafka. |

### How Kafka Works In This Project

```
                    ┌──────────────────────────────────┐
                    │          Kafka Broker             │
                    │        (localhost:9092)            │
                    │                                   │
                    │   Topic: "telemetry-raw"          │
                    │   ┌─────────┬─────────┬────────┐  │
  TCP Server ──────▶│   │ Part. 0 │ Part. 1 │ Part.2 │  │──────▶ Data Processor
  (Producer)        │   │(IMEI A) │(IMEI B) │(IMEI C)│  │        (Consumer)
                    │   └─────────┴─────────┴────────┘  │
                    └──────────────────────────────────┘
```

1. **TCP Server** (the **producer**) publishes each telemetry message with the device IMEI as the **key**.
2. Kafka uses the key to **hash-partition** — all messages from the same device go to the same partition.
3. **Data Processor** (the **consumer**) reads messages from the topic, processes them, and inserts into PostgreSQL.
4. The consumer is in a **consumer group** (`data-processor-group`) — if you run multiple instances, Kafka distributes partitions between them.

### Kafka Configuration in This Project

| Setting                  | Value               | Why                                           |
| ------------------------ | ------------------- | ---------------------------------------------- |
| Mode                     | **KRaft**           | No ZooKeeper needed (simpler setup)            |
| Replication Factor       | `1`                 | Single-node dev setup (increase in production) |
| Auto-Create Topics       | `true`              | The `telemetry-raw` topic is created automatically |
| Producer `RequiredAcks`  | `RequireAll`        | Maximum durability — wait for all replicas     |
| Producer `Async`         | `false`             | Synchronous — device is only ACK'd after Kafka confirms |
| Consumer `autoCommit`    | `true` (every 5s)   | Offsets are saved periodically                 |
| Consumer `fromBeginning` | `false`             | Only process new messages (not historical)     |

---

## Quick Reference Card

| Service          | Language    | Port   | Command                 |
| ---------------- | ----------- | ------ | ----------------------- |
| TCP Gateway      | Go          | `8500` | `npm run dev:tcp`       |
| Data Processor   | TypeScript  | —      | `npm run dev:processor` |
| Web Dashboard    | Next.js     | `3000` | `npm run dev:dashboard` |
| PostgreSQL       | —           | `5432` | `npm run infra:up`      |
| Kafka            | —           | `9092` | `npm run infra:up`      |
| Prisma Studio    | —           | `5555` | `npm run db:studio`     |
