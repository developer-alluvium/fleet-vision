import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateGeofenceCache } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ geofenceId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { geofenceId } = await params;

    const geofencesRaw: any[] = await prisma.$queryRaw`
      SELECT
        id, name, organization_id as "organizationId", description, type, color, is_active as "isActive",
        center_lat as "centerLat", center_lng as "centerLng", radius_meters as "radiusMeters",
        alert_on_enter as "alertOnEnter", alert_on_exit as "alertOnExit", speed_limit_kmh as "speedLimitKmh",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(polygon)::jsonb as polygon_geojson
      FROM "geofences"
      WHERE "organization_id" = ${auth.organizationId} AND "id" = ${geofenceId}
      LIMIT 1
    `;

    if (geofencesRaw.length === 0) {
      return NextResponse.json({ error: "Geofence not found" }, { status: 404 });
    }

    const geofence = {
      ...geofencesRaw[0],
      coordinates: geofencesRaw[0].polygon_geojson ? geofencesRaw[0].polygon_geojson.coordinates[0] : null,
      polygon_geojson: undefined
    };

    return NextResponse.json({ geofence });
  } catch (error: any) {
    console.error(`[API] GET /api/v1/geofences/[id] error:`, error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ geofenceId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { geofenceId } = await params;
    const body = await request.json();
    
    // Ensure the geofence exists and belongs to the org
    const existing = await prisma.geofence.findUnique({
      where: { id: geofenceId }
    });

    if (!existing || existing.organizationId !== auth.organizationId) {
      return NextResponse.json({ 
        success: false, 
        message: "Geofence not found", 
        error: "Geofence not found" 
      }, { status: 404 });
    }

    const { name, description, color, isActive, alertOnEnter, alertOnExit, speedLimitKmh } = body;
    // For simplicity in this plan, we do not support updating the geometry itself.
    // If geometry needs updating, users should delete and recreate, or we can add complex raw update logic.

    const updated = await prisma.geofence.update({
      where: { id: geofenceId },
      data: {
        name,
        description,
        color,
        isActive,
        alertOnEnter,
        alertOnExit,
        speedLimitKmh
      }
    });

    await invalidateGeofenceCache(auth.organizationId);

    return NextResponse.json({ 
      success: true, 
      message: "Geofence updated successfully",
      data: updated
    });
  } catch (error: any) {
    console.error(`[API] PUT /api/v1/geofences/[id] error:`, error);
    return NextResponse.json({ 
      success: false, 
      message: "Internal server error", 
      error: "Internal server error" 
    }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ geofenceId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { geofenceId } = await params;

    const existing = await prisma.geofence.findUnique({
      where: { id: geofenceId }
    });

    if (!existing || existing.organizationId !== auth.organizationId) {
      return NextResponse.json({ 
        success: false, 
        message: "Geofence not found", 
        error: "Geofence not found" 
      }, { status: 404 });
    }

    await prisma.geofence.delete({
      where: { id: geofenceId }
    });

    await invalidateGeofenceCache(auth.organizationId);

    return NextResponse.json({ 
      success: true, 
      message: "Geofence deleted successfully" 
    });
  } catch (error: any) {
    console.error(`[API] DELETE /api/v1/geofences/[id] error:`, error);
    return NextResponse.json({ 
      success: false, 
      message: "Internal server error", 
      error: "Internal server error" 
    }, { status: 500 });
  }
}
