import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";

/**
 * GET /api/v1/history?imei=xxx&start=...&end=...&orgId=...
 *
 * Returns historical telemetry data from TimescaleDB.
 * Security: Strictly enforces WHERE organizationId = orgId to prevent
 * cross-tenant data leakage.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const imei = searchParams.get("imei");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const orgId = searchParams.get("orgId");

    // ── Validation ─────────────────────────────────────────
    if (!imei) {
      return NextResponse.json(
        { error: "imei query parameter is required" },
        { status: 400 }
      );
    }

    if (!orgId) {
      return NextResponse.json(
        { error: "orgId query parameter is required" },
        { status: 400 }
      );
    }

    // Build date range filter
    const timeFilter: { gte?: Date; lte?: Date } = {};
    if (start) {
      const startDate = new Date(start);
      if (isNaN(startDate.getTime())) {
        return NextResponse.json(
          { error: "start must be a valid ISO 8601 date" },
          { status: 400 }
        );
      }
      timeFilter.gte = startDate;
    }
    if (end) {
      const endDate = new Date(end);
      if (isNaN(endDate.getTime())) {
        return NextResponse.json(
          { error: "end must be a valid ISO 8601 date" },
          { status: 400 }
        );
      }
      timeFilter.lte = endDate;
    }

    // Default: last 24 hours if no range specified
    if (!start && !end) {
      timeFilter.gte = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }

    // ── Query TimescaleDB ──────────────────────────────────
    // SECURITY: Always enforce organizationId to prevent cross-tenant access
    const records = await prisma.telemetryRecord.findMany({
      where: {
        imei,
        organizationId: orgId,
        time: timeFilter,
      },
      orderBy: { time: "desc" },
      take: 10000, // Safety limit
    });

    return NextResponse.json({
      imei,
      orgId,
      count: records.length,
      timeRange: {
        start: timeFilter.gte?.toISOString() ?? null,
        end: timeFilter.lte?.toISOString() ?? null,
      },
      records,
    });
  } catch (error) {
    console.error("[API] GET /api/v1/history error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
