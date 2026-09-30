import { NextRequest, NextResponse } from "next/server";
import { prisma, Prisma, invalidateGeofenceCache } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "20", 10);
    const search = searchParams.get("search") || "";
    const isActiveParam = searchParams.get("isActive");

    const skip = (page - 1) * limit;

    const where: any = { organizationId: auth.organizationId };
    if (search) {
      where.name = { contains: search, mode: "insensitive" };
    }
    if (isActiveParam !== null) {
      where.isActive = isActiveParam === "true";
    }

    const totalCount = await prisma.geofence.count({ where });

    // Use raw query to get ST_AsGeoJSON for the polygon
    // To do pagination with raw query, we use LIMIT and OFFSET
    // We also select all fields manually to reconstruct the object
    const geofencesRaw: any[] = await prisma.$queryRaw`
      SELECT
        id, name, organization_id as "organizationId", description, type, color, is_active as "isActive",
        center_lat as "centerLat", center_lng as "centerLng", radius_meters as "radiusMeters",
        alert_on_enter as "alertOnEnter", alert_on_exit as "alertOnExit", speed_limit_kmh as "speedLimitKmh",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(polygon)::jsonb as polygon_geojson
      FROM "geofences"
      WHERE "organization_id" = ${auth.organizationId}
        ${search ? Prisma.sql`AND "name" ILIKE ${'%' + search + '%'}` : Prisma.empty}
        ${isActiveParam !== null ? Prisma.sql`AND "is_active" = ${isActiveParam === "true"}` : Prisma.empty}
      ORDER BY "created_at" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    const geofences = geofencesRaw.map(g => ({
      ...g,
      coordinates: g.polygon_geojson ? g.polygon_geojson.coordinates[0] : null,
      polygon_geojson: undefined
    }));

    return NextResponse.json({ geofences, totalCount });
  } catch (error: any) {
    console.error("[API] GET /api/v1/geofences error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const body = await request.json();
    const { name, description, type, color, coordinates, center, radiusMeters, alertOnEnter, alertOnExit, speedLimitKmh } = body;

    if (!name) {
      return NextResponse.json({ 
        success: false, 
        message: "name is required", 
        error: "name is required" 
      }, { status: 400 });
    }

    const geofenceType = type === "CIRCLE" ? "CIRCLE" : "POLYGON";

    let polygonSql;
    if (geofenceType === "POLYGON") {
      if (!coordinates || coordinates.length < 4) {
        return NextResponse.json({ 
          success: false, 
          message: "POLYGON requires at least 4 coordinates (closed ring)", 
          error: "POLYGON requires at least 4 coordinates (closed ring)" 
        }, { status: 400 });
      }
      // coordinates is array of [lng, lat]
      const geojson = {
        type: "Polygon",
        coordinates: [coordinates]
      };
      polygonSql = Prisma.sql`ST_GeomFromGeoJSON(${JSON.stringify(geojson)}::jsonb)`;
    } else {
      if (!center || !center.lat || !center.lng || !radiusMeters) {
        return NextResponse.json({ 
          success: false, 
          message: "CIRCLE requires center and radiusMeters", 
          error: "CIRCLE requires center and radiusMeters" 
        }, { status: 400 });
      }
      // For circle, we store the actual circle approximation in polygon to still work with ST_Contains for fallback
      polygonSql = Prisma.sql`ST_Buffer(ST_SetSRID(ST_Point(${center.lng}, ${center.lat}), 4326)::geography, ${radiusMeters})::geometry`;
    }

    const id = require("crypto").randomUUID();

    await prisma.$executeRaw`
      INSERT INTO "geofences" (
        "id", "name", "description", "type", "color", "is_active", 
        "center_lat", "center_lng", "radius_meters",
        "alert_on_enter", "alert_on_exit", "speed_limit_kmh", 
        "organization_id", "created_at", "updated_at", "polygon"
      ) VALUES (
        ${id}, ${name}, ${description}, ${geofenceType}, ${color || "#3B82F6"}, true,
        ${center?.lat ?? null}, ${center?.lng ?? null}, ${radiusMeters ?? null},
        ${alertOnEnter ?? true}, ${alertOnExit ?? true}, ${speedLimitKmh ?? null},
        ${auth.organizationId}, NOW(), NOW(), ${polygonSql}
      )
    `;

    const geofence = await prisma.geofence.findUnique({
      where: { id }
    });

    await invalidateGeofenceCache(auth.organizationId);

    return NextResponse.json({
      success: true,
      message: "Geofence created successfully",
      data: geofence,
      geofence // preserved for backwards-compatibility
    }, { status: 201 });
  } catch (error: any) {
    console.error("[API] POST /api/v1/geofences error:", error);
    if (error.code === 'P2002') {
      return NextResponse.json({ 
        success: false, 
        message: "Geofence with this name already exists", 
        error: "Geofence with this name already exists" 
      }, { status: 409 });
    }
    return NextResponse.json({ 
      success: false, 
      message: "Internal server error", 
      error: "Internal server error" 
    }, { status: 500 });
  }
}
