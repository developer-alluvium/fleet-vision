import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { prisma } from "@fleet-vision/db";

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    const { searchParams } = new URL(request.url);
    const imei = searchParams.get("imei");
    const orgId = searchParams.get("orgId");
    let since = searchParams.get("since");

    if (!imei || !orgId) {
      return NextResponse.json(
        { error: "imei and orgId query parameters are required" },
        { status: 400 }
      );
    }

    if (auth.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Forbidden: You can only access your own organization's data" },
        { status: 403 }
      );
    }

    // Default since to 1 hour ago
    let sinceDate = new Date(Date.now() - 60 * 60 * 1000);
    if (since) {
      const parsed = new Date(since);
      if (!isNaN(parsed.getTime())) {
        sinceDate = parsed;
      } else {
        return NextResponse.json({ error: "Invalid since ISO date format" }, { status: 400 });
      }
    }

    const records = await prisma.telemetryRecord.findMany({
      where: {
        imei,
        organizationId: orgId,
        time: {
          gte: sinceDate,
        },
      },
      orderBy: { time: "asc" },
      take: 10000,
      select: {
        time: true,
        serverCreatedAt: true,
        latitude: true,
        longitude: true,
        speed: true,
        ignition: true,
      }
    });

    return NextResponse.json({
      imei,
      orgId,
      since: sinceDate.toISOString(),
      pointCount: records.length,
      journey: records.map(r => ({
        lat: r.latitude,
        lng: r.longitude,
        speed: r.speed,
        ignition: r.ignition,
        time: r.time,
        serverCreatedAt: r.serverCreatedAt,
      })),
    });
  } catch (error: any) {
    console.error("[API] GET /api/v1/journey error:", error);
    if (error.message?.includes("Authentication required") || error.message?.includes("Invalid token")) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
