import { NextRequest, NextResponse } from "next/server";
import { getLiveMap } from "@fleet-vision/db";

/**
 * GET /api/v1/live-locations?orgId=xxx
 *
 * Returns all live device locations for an organization.
 * Data is served directly from Redis (O(1) lookup) — never queries PostgreSQL.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get("orgId");

    if (!orgId) {
      return NextResponse.json(
        { error: "orgId query parameter is required" },
        { status: 400 }
      );
    }

    // ── Query Redis Live Map ───────────────────────────────
    const liveMap = await getLiveMap(orgId);

    return NextResponse.json({
      orgId,
      deviceCount: Object.keys(liveMap).length,
      devices: liveMap,
    });
  } catch (error) {
    console.error("[API] GET /api/v1/live-locations error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
