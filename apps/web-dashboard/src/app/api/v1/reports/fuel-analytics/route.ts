import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";
import {
  computeVehicleFuelAnalytics,
  aggregateFleetFuelSummary,
  VehicleFuelResult,
  FuelTelemetryRow,
  GroupBy,
} from "@/lib/fuelAnalytics";

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

    // Cap at 90 days
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
        fleetFuelSummary: null,
        vehicles: [],
        metadata: {
          queryTimeMs: 0,
          vehiclesQueried: 0,
          vehiclesWithFuelData: 0,
          totalTelemetryPoints: 0,
          thresholds: {
            refuelMinLiters: 5,
            drainMinLiters: 5,
            lowFuelLiters: 50,
            criticalFuelLiters: 20,
            maxGapMinutes: 240
          }
        },
      });
    }

    const queryStartTime = Date.now();

    // ── Build per-vehicle analytics ─────────────────────────
    const periodStartMs = startDate.getTime();
    const periodEndMs = endDate.getTime();

    const vehicleResults: VehicleFuelResult[] = [];
    let totalTelemetryPoints = 0;

    for (const vehicle of vehicles) {
      const imei = vehicle.device?.imei;

      if (!imei) {
        // Vehicle has no device assigned
        vehicleResults.push({
          vehicleId: vehicle.id,
          plateNumber: vehicle.plateNumber,
          imei: "",
          make: vehicle.make,
          model: vehicle.model,
          fuelType: vehicle.fuelType,
          maxFuelCapacity: vehicle.maxFuelCapacity,
          summary: {
            fuelConsumedLiters: null,
            fuelEfficiencyKmPerL: null,
            fuelEfficiencyL100Km: null,
            totalDistanceKm: 0,
            fuelStartLiters: null,
            fuelEndLiters: null,
            currentFuelPercent: null,
            avgFuelLevelLiters: null,
            minFuelLevelLiters: null,
            maxFuelLevelLiters: null,
            avgDailyConsumptionLiters: null,
            estimatedRangeKm: null,
            refuelEvents: 0,
            drainEvents: 0,
            theftSuspectedEvents: 0,
            telemetryPoints: 0,
          },
          fuelTimeSeries: [],
          events: [],
        });
        continue;
      }

      // Raw SQL for telemetry_records
      const records: FuelTelemetryRow[] = await prisma.$queryRaw`
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

      const { summary, fuelTimeSeries, events } = computeVehicleFuelAnalytics(
        records,
        groupBy,
        periodStartMs,
        periodEndMs,
        vehicle.maxFuelCapacity
      );

      vehicleResults.push({
        vehicleId: vehicle.id,
        plateNumber: vehicle.plateNumber,
        imei,
        make: vehicle.make,
        model: vehicle.model,
        fuelType: vehicle.fuelType,
        maxFuelCapacity: vehicle.maxFuelCapacity,
        summary,
        fuelTimeSeries,
        events,
      });
    }

    // ── Fleet-wide aggregation ──────────────────────────────
    const fleetFuelSummary = aggregateFleetFuelSummary(vehicleResults);

    return NextResponse.json({
      orgId,
      period: { start: startDate.toISOString(), end: endDate.toISOString() },
      groupBy,
      fleetFuelSummary,
      vehicles: vehicleResults,
      metadata: {
        queryTimeMs: Date.now() - queryStartTime,
        vehiclesQueried: vehicles.length,
        vehiclesWithFuelData: fleetFuelSummary.vehiclesWithFuelData,
        totalTelemetryPoints,
        thresholds: {
          refuelMinLiters: 5,
          drainMinLiters: 5,
          lowFuelLiters: 50,
          criticalFuelLiters: 20,
          maxGapMinutes: 240
        }
      },
    });

  } catch (error: any) {
    console.error("[API] GET /api/v1/reports/fuel-analytics error:", error);
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
