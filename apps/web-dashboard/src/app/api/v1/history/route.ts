import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";
import { calculateJourneySummary } from "@/lib/journeySummary";
import { adaptiveSimplifyRoute } from "@/lib/douglasPeucker";

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

    // ── Query TimescaleDB ──────────────────────────────────
    // SECURITY: Always enforce organizationId to prevent cross-tenant access
    // Fetch raw rows directly using $queryRaw to avoid Prisma ORM overhead
    // We order by time ASC because journey calculation and drawing a path needs chronological order
    const records: any[] = await prisma.$queryRaw`
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
