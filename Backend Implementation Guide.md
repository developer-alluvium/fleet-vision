# **Backend Implementation Guide: Fleet Vision Enterprise**

**Target Audience:** AI Coding Assistant / Backend Engineering Team

**Project Type:** Turborepo Monorepo (Next.js, Node.js, Go)

**Goal:** Implement the backend APIs, Data Processing Pipeline, and Database Schema for a Multi-Tenant Bring-Your-Own-Device (BYOD) IoT Fleet Management platform.

## **1\. Monorepo Context**

The workspace uses Turborepo with the following relevant structure:

* packages/db: Shared Prisma ORM and database client.  
* apps/web-dashboard: Next.js 14 (App Router) used strictly for REST APIs (Control Plane & Consumption).  
* apps/data-processor: Node.js/TypeScript background worker (Kafka Consumer).  
* apps/tcp-server: Go-based TCP server (Ingestion \- assumes already parsing Codec 8E and pushing to Kafka topic telemetry-raw).

## **2\. Infrastructure Setup (Root Level)**

**File:** /docker-compose.yml

**Action:** Ensure the local environment has PostgreSQL, Redis, Kafka, and Zookeeper.

version: '3.8'  
services:  
  postgres:  
    image: timescale/timescaledb:latest-pg15  
    environment:  
      POSTGRES\_USER: root  
      POSTGRES\_PASSWORD: password  
      POSTGRES\_DB: fleet\_vision  
    ports:  
      \- "5432:5432"

  redis:  
    image: redis:alpine  
    ports:  
      \- "6379:6379"

  zookeeper:  
    image: confluentinc/cp-zookeeper:7.4.0  
    environment:  
      ZOOKEEPER\_CLIENT\_PORT: 2181  
      ZOOKEEPER\_TICK\_TIME: 2000  
    ports:  
      \- "2181:2181"

  kafka:  
    image: confluentinc/cp-kafka:7.4.0  
    depends\_on:  
      \- zookeeper  
    ports:  
      \- "9092:9092"  
    environment:  
      KAFKA\_BROKER\_ID: 1  
      KAFKA\_ZOOKEEPER\_CONNECT: zookeeper:2181  
      KAFKA\_ADVERTISED\_LISTENERS: PLAINTEXT://localhost:9092  
      KAFKA\_OFFSETS\_TOPIC\_REPLICATION\_FACTOR: 1

## **3\. Database Schema Implementation**

**File:** /packages/db/prisma/schema.prisma

**Action:** Implement the Multi-Tenant Enterprise Schema.

**Notes:** After generating, the AI must run npx prisma migrate dev \--name init\_enterprise inside packages/db.

generator client {  
  provider \= "prisma-client-js"  
}

datasource db {  
  provider \= "postgresql"  
  url      \= env("DATABASE\_URL")  
}

model Organization {  
  id        String    @id @default(cuid())  
  name      String  
  users     User\[\]  
  devices   Device\[\]  
  vehicles  Vehicle\[\]  
  createdAt DateTime  @default(now())  
}

model User {  
  id             String       @id @default(cuid())  
  email          String       @unique  
  role           String       @default("ADMIN")  
  organizationId String  
  organization   Organization @relation(fields: \[organizationId\], references: \[id\])  
}

model Device {  
  id             String       @id @default(cuid())  
  imei           String       @unique  
  status         String       @default("PENDING\_CONNECTION")  
    
  organizationId String  
  organization   Organization @relation(fields: \[organizationId\], references: \[id\])  
    
  vehicle        Vehicle?   
  createdAt      DateTime     @default(now())  
}

model Vehicle {  
  id              String       @id @default(cuid())  
  plateNumber     String       @unique  
  maxFuelCapacity Float?         
    
  organizationId  String  
  organization    Organization @relation(fields: \[organizationId\], references: \[id\])  
    
  deviceId        String?      @unique  
  device          Device?      @relation(fields: \[deviceId\], references: \[id\])  
}

model TelemetryRecord {  
  id             String   @id @default(cuid())  
  time           DateTime @default(now())  
  imei           String  
  organizationId String     
  latitude       Float?  
  longitude      Float?  
  speed          Float?  
  ignition       Boolean  @default(false)  
  ioElements     Json?    // Stores raw hardware variables

  @@index(\[time(sort: Desc)\])  
  @@index(\[imei, time(sort: Desc)\])  
}

## **4\. Provisioning APIs (Control Plane)**

**Workspace:** apps/web-dashboard

**Tech:** Next.js App Router Route Handlers (src/app/api/...)

**Dependencies Required:** @fleet-vision/db (workspace), ioredis.

### **A. Create Organization**

* **Path:** POST /api/organizations  
* **Logic:** Accepts { "name": "FedEx", "email": "admin@fedex.com" }. Creates Organization and User in PostgreSQL using Prisma.

### **B. Register BYOD Device**

* **Path:** POST /api/devices  
* **Payload:** { "imei": "123456789012345", "orgId": "\<cuid\>" }  
* **Logic:**  
  1. Check if IMEI exists. If yes, return 400\.  
  2. Create Device in PostgreSQL linked to orgId with status PENDING\_CONNECTION.  
  3. **CRITICAL REDIS SYNC:** Execute redis.hset('auth:${imei}', { isAuthorized: 'true', orgId: orgId }).

## **5\. The Data Processor (Kafka Consumer)**

**Workspace:** apps/data-processor

**Tech:** Node.js/TypeScript

**Dependencies Required:** kafkajs, ioredis, @fleet-vision/db.

**File:** src/processor.ts (or similar main entry)

**Logic Flow requirements for the AI:**

1. Connect to Kafka broker (localhost:9092) and subscribe to topic telemetry-raw.  
2. Consume messages in batches (eachBatch).  
3. Loop through the batch:  
   * **Lookup:** For each message's IMEI, execute redis.hgetall('auth:${imei}').  
   * **Validation:** If isAuthorized \!== 'true', drop the message completely.  
   * **State Update:** If authorized, execute redis.hset('live\_map:org:${orgId}', imei, JSON.stringify(payload)).  
   * **Transform:** Append the orgId from Redis to the raw payload object.  
4. **Bulk Insert:** After looping the batch, take all authorized, transformed records and execute prisma.telemetryRecord.createMany({ data: validRecordsArray }).

## **6\. Consumption APIs (Data Plane)**

**Workspace:** apps/web-dashboard

**Tech:** Next.js App Router Route Handlers (src/app/api/...)

### **A. Get Live Map Data**

* **Path:** GET /api/live-locations?orgId=\<cuid\>  
* **Logic:** Do NOT query PostgreSQL. Execute redis.hgetall('live\_map:org:${orgId}'). Map the hash values from strings to JSON and return the array.

### **B. Get Historical Route**

* **Path:** GET /api/history?imei=\<imei\>\&orgId=\<cuid\>\&start=\<iso\_date\>\&end=\<iso\_date\>  
* **Logic:** Query PostgreSQL using Prisma.  
  prisma.telemetryRecord.findMany({  
    where: {  
      imei: imei,  
      organizationId: orgId, // CRITICAL FOR TENANT ISOLATION  
      time: { gte: new Date(start), lte: new Date(end) }  
    },  
    orderBy: { time: 'asc' }  
  })  
