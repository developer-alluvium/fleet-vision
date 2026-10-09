import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const { searchParams } = new URL(request.url);
    
    const cursor = searchParams.get("cursor");
    let limit = parseInt(searchParams.get("limit") || "50", 10);
    if (limit > 100) limit = 100;
    
    const geofenceId = searchParams.get("geofenceId");
    const imei = searchParams.get("imei");
    const eventType = searchParams.get("eventType");
    const status = searchParams.get("status");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const includeCount = searchParams.get("includeCount") === "true";

    const alertsWhere: any = { 
      organizationId: auth.organizationId,
      category: "GEOFENCE"
    };
    const episodesWhere: any = {
      organizationId: auth.organizationId
    };
    
    if (geofenceId) {
      alertsWhere.geofenceId = geofenceId;
      episodesWhere.geofenceId = geofenceId;
    }
    if (imei) {
      alertsWhere.imei = imei;
      episodesWhere.imei = imei;
    }
    
    let fetchAlerts = true;
    let fetchEpisodes = true;
    
    if (status === "OPEN") {
      episodesWhere.status = "OPEN";
      fetchAlerts = false; // Alerts don't have OPEN status
    }
    
    if (eventType) {
      if (eventType === "ENTER" || eventType === "EXIT") {
        alertsWhere.eventType = eventType;
        fetchEpisodes = false; // Episodes are only for speed violations
      } else if (eventType === "SPEED_VIOLATION") {
        alertsWhere.eventType = "SPEED_VIOLATION";
      }
    }
    
    if (from || to) {
      alertsWhere.createdAt = {};
      episodesWhere.createdAt = {};
      if (from) {
        alertsWhere.createdAt.gte = new Date(from);
        episodesWhere.createdAt.gte = new Date(from);
      }
      if (to) {
        alertsWhere.createdAt.lte = new Date(to);
        episodesWhere.createdAt.lte = new Date(to);
      }
    }

    if (cursor) {
      const parts = cursor.split("_");
      if (parts.length === 2) {
        const cursorDate = new Date(parseInt(parts[0], 10));
        const cursorId = parts[1];
        
        const cursorCondition = {
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: cursorDate, id: { lt: cursorId } }
          ]
        };
        alertsWhere.AND = [cursorCondition];
        episodesWhere.AND = [cursorCondition];
      }
    }

    const promises: Promise<any>[] = [];
    
    if (fetchAlerts) {
      promises.push(
        prisma.alert.findMany({
          where: alertsWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          include: { geofence: { select: { name: true, type: true } } }
        })
      );
    } else {
      promises.push(Promise.resolve([]));
    }
    
    if (fetchEpisodes) {
      promises.push(
        prisma.geofenceViolationEpisode.findMany({
          where: episodesWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          include: { geofence: { select: { name: true, type: true } } }
        }).then(episodes => episodes.map(ep => ({
          ...ep,
          category: "GEOFENCE",
          eventType: "SPEED_VIOLATION",
          timestamp: ep.startedAt,
          latitude: ep.startLat,
          longitude: ep.startLng,
          speed: ep.peakSpeedKmh // approximate mapping for legacy clients
        })))
      );
    } else {
      promises.push(Promise.resolve([]));
    }
    
    if (includeCount) {
      promises.push(
        fetchAlerts ? prisma.alert.count({ where: alertsWhere }) : Promise.resolve(0),
        fetchEpisodes ? prisma.geofenceViolationEpisode.count({ where: episodesWhere }) : Promise.resolve(0)
      );
    }
    
    const results = await Promise.all(promises);
    const rawAlerts = results[0];
    const rawEpisodes = results[1];
    
    // Merge and sort
    const merged = [...rawAlerts, ...rawEpisodes].sort((a, b) => {
      const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      if (a.id > b.id) return -1;
      if (a.id < b.id) return 1;
      return 0;
    });
    
    let nextCursor = null;
    let alerts = merged;
    
    if (merged.length > limit) {
      alerts = merged.slice(0, limit);
      const lastItem = alerts[alerts.length - 1];
      nextCursor = `${lastItem.createdAt.getTime()}_${lastItem.id}`;
    }
    
    const response: any = { alerts, nextCursor };
    
    if (includeCount) {
      response.totalCount = results[2] + results[3];
    }
    
    return NextResponse.json(response);
  } catch (error: any) {
    console.error(`[API] GET /api/v1/geofences/alerts error:`, error);
    if (error.message && (error.message.includes("Authentication required") || error.message.includes("Invalid token") || error.message.includes("API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
