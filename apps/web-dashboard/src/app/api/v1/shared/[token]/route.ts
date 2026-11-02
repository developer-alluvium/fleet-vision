import { NextRequest, NextResponse } from "next/server";
import { timescalePrisma } from "@fleet-vision/db";
import { resolveShare, SHARE_SECURITY_HEADERS } from "@/lib/shareJourney";
import { adaptiveSimplifyRoute } from "@/lib/douglasPeucker";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { token } = await params;

    const resolved = await resolveShare(token, { incrementAccessCount: true });
    if (!resolved.success) {
      return NextResponse.json(
        { error: resolved.error },
        { status: resolved.status, headers: SHARE_SECURITY_HEADERS }
      );
    }

    // Query historical telemetry from TimescaleDB with strict tenant isolation and hard cap
    const records = await timescalePrisma.telemetryRecord.findMany({
      where: {
        imei: resolved.imei,
        organizationId: resolved.share.organizationId, // Strict org isolation
        time: {
          gte: resolved.share.startsAt,
          lte: resolved.share.expiresAt,
        },
      },
      orderBy: { time: "asc" },
      take: 5000, // Protection against memory overflow
      select: {
        time: true,
        latitude: true,
        longitude: true,
        speed: true,
        ignition: true,
      },
    });

    // Format points with data minimization (hide speed if requested), filtering null coords
    const points = records
      .filter(
        (r): r is typeof r & { latitude: number; longitude: number } =>
          r.latitude !== null && r.longitude !== null
      )
      .map((r) => ({
        lat: r.latitude,
        lng: r.longitude,
        speed: resolved.share.showSpeed ? r.speed : undefined,
        ignition: r.ignition,
        time: r.time,
      }));

    // Downsample large journeys using Douglas-Peucker algorithm
    const { route: simplifiedPoints } = adaptiveSimplifyRoute(points);

    // Filter vehicle info based on share privacy settings
    const vehicleInfo = resolved.share.showVehicleInfo
      ? {
          plateNumber: resolved.vehicle.plateNumber,
          make: resolved.vehicle.make,
          model: resolved.vehicle.model,
          vehicleType: resolved.vehicle.vehicleType,
        }
      : {
          plateNumber: resolved.vehicle.plateNumber,
        };

    const remainingMinutes = Math.max(
      0,
      Math.floor((resolved.share.expiresAt.getTime() - Date.now()) / 60000)
    );

    return NextResponse.json(
      {
        share: {
          label: resolved.share.label,
          startsAt: resolved.share.startsAt.toISOString(),
          expiresAt: resolved.share.expiresAt.toISOString(),
          remainingMinutes,
          status: "ACTIVE",
          showSpeed: resolved.share.showSpeed,
          showVehicleInfo: resolved.share.showVehicleInfo,
        },
        vehicle: vehicleInfo,
        journey: {
          pointCount: simplifiedPoints.length,
          rawPointCount: records.length,
          points: simplifiedPoints,
        },
      },
      {
        status: 200,
        headers: SHARE_SECURITY_HEADERS,
      }
    );
  } catch (error: any) {
    console.error("[API] GET /api/v1/shared/[token] error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: SHARE_SECURITY_HEADERS }
    );
  }
}
