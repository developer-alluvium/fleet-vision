import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";
import {
  computeVehicleUtilization,
  aggregateFleetSummary,
  VehicleUtilization,
  TelemetryRow,
  GroupBy,
} from "@/lib/utilizationReport";

/**
 * GET /api/v1/reports/utilization?start=...&end=...&vehicleIds=...&groupBy=...
 *
 * Returns an advanced utilization report for the authenticated organization's fleet.
 * Queries TimescaleDB telemetry data over a date range and computes per-vehicle
 * driving / idle / stopped durations, distance, speed, fuel, and utilization %.
 *
 * Query Parameters:
 *   start      — ISO 8601 start date (default: 24h ago)
 *   end        — ISO 8601 end date   (default: now)
 *   vehicleIds — Comma-separated vehicle IDs to filter (default: all)
 *   groupBy    — Time bucketing: hour | day | week (default: day)
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const orgId = auth.organizationId;

    if (!orgId) {
      return NextResponse.json(
        { error: "Could not determine organization from authentication" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);

    // ── Parse & validate parameters ─────────────────────────

    let startDate: Date;
    let endDate: Date;

    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");

    if (startParam) {
      startDate = new Date(startParam);
      if (isNaN(startDate.getTime())) {
        return NextResponse.json({ error: "start must be a valid ISO 8601 date" }, { status: 400 });
      }
    } else {
      startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }

    if (endParam) {
      endDate = new Date(endParam);
      if (isNaN(endDate.getTime())) {
        return NextResponse.json({ error: "end must be a valid ISO 8601 date" }, { status: 400 });
      }
    } else {
      endDate = new Date();
    }

    if (startDate >= endDate) {
      return NextResponse.json({ error: "start must be before end" }, { status: 400 });
    }

    // Cap at 90 days to prevent extremely expensive queries
    const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
    if (endDate.getTime() - startDate.getTime() > MAX_RANGE_MS) {
      return NextResponse.json(
        { error: "Maximum date range is 90 days" },
        { status: 400 }
      );
    }

    const groupByParam = (searchParams.get("groupBy") || "day") as string;
    if (!["hour", "day", "week"].includes(groupByParam)) {
      return NextResponse.json(
        { error: "groupBy must be one of: hour, day, week" },
        { status: 400 }
      );
    }
    const groupBy = groupByParam as GroupBy;

    // ── Resolve vehicles ────────────────────────────────────

    const vehicleIdsParam = searchParams.get("vehicleIds");
    const vehicleIdFilter = vehicleIdsParam
      ? vehicleIdsParam.split(",").map(id => id.trim()).filter(Boolean)
      : null;

    const vehicleWhere: any = { organizationId: orgId };
    if (vehicleIdFilter && vehicleIdFilter.length > 0) {
      vehicleWhere.id = { in: vehicleIdFilter };
    }

    const vehicles = await prisma.vehicle.findMany({
      where: vehicleWhere,
      include: { device: { select: { imei: true } } },
      orderBy: { plateNumber: "asc" },
    });

    if (vehicles.length === 0) {
      return NextResponse.json({
        orgId,
        period: { start: startDate.toISOString(), end: endDate.toISOString() },
        groupBy,
        fleetSummary: null,
        vehicles: [],
        metadata: {
          queryTimeMs: 0,
          vehiclesQueried: 0,
          vehiclesWithData: 0,
          totalTelemetryPoints: 0,
        },
      });
    }

    const queryStartTime = Date.now();

    // ── Build per-vehicle utilization ────────────────────────

    const periodStartMs = startDate.getTime();
    const periodEndMs = endDate.getTime();
    const periodDays = (periodEndMs - periodStartMs) / (24 * 60 * 60 * 1000);

    const vehicleResults: VehicleUtilization[] = [];
    let totalTelemetryPoints = 0;

    for (const vehicle of vehicles) {
      const imei = vehicle.device?.imei;

      if (!imei) {
        // Vehicle has no device assigned — include with zero data
        vehicleResults.push({
          vehicleId: vehicle.id,
          plateNumber: vehicle.plateNumber,
          imei: "",
          make: vehicle.make,
          model: vehicle.model,
          summary: {
            totalDistanceKm: 0,
            drivingMinutes: 0,
            idleMinutes: 0,
            stoppedMinutes: 0,
            utilizationPercent: 0,
            maxSpeedKmh: 0,
            avgSpeedKmh: 0,
            telemetryPoints: 0,
            startOdometer: null,
            endOdometer: null,
            fuelStartLiters: null,
            fuelEndLiters: null,
            fuelConsumedLiters: null,
          },
          timeSeries: [],
        });
        continue;
      }

      // Raw SQL for performance on large datasets (same pattern as /api/v1/history)
      const records: TelemetryRow[] = await prisma.$queryRaw`
        SELECT
          time,
          latitude  AS lat,
          longitude AS lng,
          speed,
          ignition,
          fuel_level_raw    AS "fuelLevelRaw",
          fuel_level_liters AS "fuelLevelLiters",
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

      totalTelemetryPoints += records.length;

      const { summary, timeSeries } = computeVehicleUtilization(
        records,
        groupBy,
        periodStartMs,
        periodEndMs,
      );

      vehicleResults.push({
        vehicleId: vehicle.id,
        plateNumber: vehicle.plateNumber,
        imei,
        make: vehicle.make,
        model: vehicle.model,
        summary,
        timeSeries,
      });
    }

    // ── Fleet-wide aggregation ──────────────────────────────

    const fleetSummary = aggregateFleetSummary(vehicleResults, vehicles.length, periodDays);

    return NextResponse.json({
      orgId,
      period: { start: startDate.toISOString(), end: endDate.toISOString() },
      groupBy,
      fleetSummary,
      vehicles: vehicleResults,
      metadata: {
        queryTimeMs: Date.now() - queryStartTime,
        vehiclesQueried: vehicles.length,
        vehiclesWithData: fleetSummary.vehiclesWithData,
        totalTelemetryPoints,
      },
    });

  } catch (error: any) {
    console.error("[API] GET /api/v1/reports/utilization error:", error);
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
