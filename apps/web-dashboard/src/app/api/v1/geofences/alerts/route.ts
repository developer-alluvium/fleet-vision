import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { searchParams } = new URL(request.url);
    
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const geofenceId = searchParams.get("geofenceId");
    const imei = searchParams.get("imei");
    const eventType = searchParams.get("eventType");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const skip = (page - 1) * limit;
    
    const where: any = { organizationId: auth.organizationId };
    
    if (geofenceId) where.geofenceId = geofenceId;
    if (imei) where.imei = imei;
    if (eventType) where.eventType = eventType;
    
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [alerts, totalCount] = await Promise.all([
      prisma.geofenceAlert.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          geofence: { select: { name: true, type: true } }
        }
      }),
      prisma.geofenceAlert.count({ where })
    ]);

    return NextResponse.json({ alerts, totalCount });
  } catch (error: any) {
    console.error(`[API] GET /api/v1/geofences/alerts error:`, error);
    if (error.message && (error.message.includes("Authentication required") || error.message.includes("Invalid token") || error.message.includes("API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
