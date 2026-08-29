import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";
import { calculateJourneySummary } from "@/lib/journeySummary";
import { adaptiveSimplifyRoute } from "@/lib/douglasPeucker";
import fs from "fs/promises";
import path from "path";
import { ParquetReader } from "@dsnp/parquetjs";

/**
 * GET /api/v1/history?imei=xxx&start=...&end=...&orgId=...
 *
 * Returns historical telemetry data from TimescaleDB with adaptive
 * route simplification and journey summary calculation.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const imei = searchParams.get("imei");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    let orgId = searchParams.get("orgId");

    const auth = await authenticate(request);
    
    // Check authorization matches orgId if provided
    if (orgId && auth.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Unauthorized access to this organization" },
        { status: 403 }
      );
    }

    // Use orgId from auth if not provided
    orgId = orgId || auth.organizationId;

    // ── Validation ─────────────────────────────────────────
    if (!imei) {
      return NextResponse.json(
        { error: "imei query parameter is required" },
        { status: 400 }
      );
    }

    if (!orgId) {
      return NextResponse.json(
        { error: "orgId is required and could not be determined from authentication" },
        { status: 400 }
      );
    }

    // Build date range filter
    let startDate: Date;
    let endDate: Date;

    if (start) {
      startDate = new Date(start);
      if (isNaN(startDate.getTime())) {
        return NextResponse.json({ error: "start must be a valid ISO 8601 date" }, { status: 400 });
      }
    } else {
      startDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // Default to last 24 hours
    }

    if (end) {
      endDate = new Date(end);
      if (isNaN(endDate.getTime())) {
        return NextResponse.json({ error: "end must be a valid ISO 8601 date" }, { status: 400 });
      }
    } else {
      endDate = new Date(); // Default to now
    }

    const queryStartTime = Date.now();

    const RETENTION_MONTHS = parseInt(process.env.RETENTION_MONTHS || "6", 10);
    const cutoffDate = new Date();
    if (process.env.RETENTION_HOURS) {
      cutoffDate.setHours(cutoffDate.getHours() - parseInt(process.env.RETENTION_HOURS, 10));
    } else {
      cutoffDate.setMonth(cutoffDate.getMonth() - RETENTION_MONTHS);
    }

    let records: any[] = [];

    // ── 1. Query Parquet (Cold Storage) ─────────────────────
    const ENABLE_COLD_STORAGE = process.env.ENABLE_COLD_STORAGE === "true";
    if (ENABLE_COLD_STORAGE && startDate < cutoffDate) {
      try {
        // Find the archives directory (2 levels up from web-dashboard root in the monorepo)
        const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(process.cwd(), "../../archives");
        
        // Ensure directory exists to prevent errors
        await fs.access(ARCHIVE_DIR).catch(() => fs.mkdir(ARCHIVE_DIR, { recursive: true }));
        
        const files = await fs.readdir(ARCHIVE_DIR);
        const parquetFiles = files.filter(f => f.endsWith(".parquet"));

        for (const file of parquetFiles) {
          const filepath = path.join(ARCHIVE_DIR, file);
          const reader = await ParquetReader.openFile(filepath);
          const cursor = reader.getCursor();
          let record: any = null;
          
          while (record = await cursor.next()) {
            const time = new Date(record.time);
            if (
              record.imei === imei &&
              record.organizationId === orgId &&
              time >= startDate &&
              time <= endDate &&
              record.latitude !== null &&
              record.latitude !== undefined &&
              record.longitude !== null &&
              record.longitude !== undefined
            ) {
              records.push({
                time: time,
                lat: record.latitude,
                lng: record.longitude,
                speed: record.speed || 0,
                ignition: record.ignition,
                fuelLevelRaw: record.fuelLevelRaw,
                odometer: record.odometer
              });
            }
          }
          await reader.close();
        }
      } catch (err) {
        console.error("[API] Error reading from Parquet archives:", err);
        // Continue even if parquet fails, to at least return hot data
      }
    }

    // ── 2. Query TimescaleDB (Hot Storage) ──────────────────
    // Fetch raw rows directly using $queryRaw to avoid Prisma ORM overhead
    // We order by time ASC because journey calculation and drawing a path needs chronological order
    const dbRecords: any[] = await prisma.$queryRaw`
      SELECT 
        time, 
        latitude as lat, 
        longitude as lng, 
        speed, 
        ignition,
        fuel_level_raw as "fuelLevelRaw",
        odometer
      FROM telemetry_records
      WHERE imei = ${imei} 
        AND organization_id = ${orgId}
        AND time >= ${startDate}
        AND time <= ${endDate}
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
      ORDER BY time ASC
    `;

    // ── 3. Merge and Sort ───────────────────────────────────
    records = [...records, ...dbRecords].sort((a, b) => a.time.getTime() - b.time.getTime());

    const totalTelemetryPoints = records.length;

    if (totalTelemetryPoints === 0) {
      return NextResponse.json({
        imei,
        orgId,
        summary: null,
        route: [],
        metadata: {
          totalTelemetryPoints: 0,
          returnedRoutePoints: 0,
          simplified: false,
          queryTimeMs: Date.now() - queryStartTime
        }
      });
    }

    // ── Calculate Summary ──────────────────────────────────
    const summary = calculateJourneySummary(records);

    // ── Simplify Route ─────────────────────────────────────
    const { route, simplified } = adaptiveSimplifyRoute(records);

    return NextResponse.json({
      imei,
      orgId,
      summary,
      route,
      metadata: {
        totalTelemetryPoints,
        returnedRoutePoints: route.length,
        simplified,
        queryTimeMs: Date.now() - queryStartTime
      }
    });

  } catch (error: any) {
    console.error("[API] GET /api/v1/history error:", error);
    if (
      error.message &&
      (error.message.includes("Authentication required") ||
        error.message.includes("Invalid token") ||
        error.message.includes("API key"))
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
