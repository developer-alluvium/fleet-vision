import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ geofenceId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { geofenceId } = await params;
    const { latitude, longitude } = await request.json();

    if (latitude == null || longitude == null) {
      return NextResponse.json({ error: "latitude and longitude are required" }, { status: 400 });
    }

    // Check if point is inside
    const result: any[] = await prisma.$queryRaw`
      SELECT 
        ST_Contains(polygon, ST_SetSRID(ST_Point(${longitude}, ${latitude}), 4326)) as inside,
        ST_Distance(
          polygon::geography, 
          ST_SetSRID(ST_Point(${longitude}, ${latitude}), 4326)::geography
        ) as distance_meters
      FROM "geofences"
      WHERE "organization_id" = ${auth.organizationId} AND "id" = ${geofenceId}
    `;

    if (result.length === 0) {
      return NextResponse.json({ error: "Geofence not found" }, { status: 404 });
    }

    return NextResponse.json({
      inside: result[0].inside,
      distanceMeters: result[0].distance_meters
    });
  } catch (error: any) {
    console.error(`[API] POST /api/v1/geofences/[id]/test error:`, error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
