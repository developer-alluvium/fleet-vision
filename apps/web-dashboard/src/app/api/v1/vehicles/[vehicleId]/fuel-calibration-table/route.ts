import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateCalibrationCache, cacheCalibrationTable } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ vehicleId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { vehicleId } = await params;

    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { calibrationPoints: { orderBy: { rawValue: "asc" } } },
    });

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    if (vehicle.organizationId !== auth.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    return NextResponse.json({
      vehicleId: vehicle.id,
      points: vehicle.calibrationPoints.map((p) => ({
        rawValue: p.rawValue,
        liters: p.liters,
      })),
    });
  } catch (error: any) {
    console.error("[API] GET fuel-calibration-table error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ vehicleId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { vehicleId } = await params;
    const body = await request.json();

    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { device: true },
    });

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    if (vehicle.organizationId !== auth.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const { points } = body;

    if (!points || !Array.isArray(points) || points.length < 2) {
      return NextResponse.json(
        { error: "At least 2 calibration points are required" },
        { status: 400 }
      );
    }

    // Validation
    const seenRawValues = new Set<number>();
    let prevLiters = -1;

    // Must sort first for logic check
    const sortedPoints = [...points].sort((a, b) => a.rawValue - b.rawValue);

    for (const point of sortedPoints) {
      if (typeof point.rawValue !== "number" || typeof point.liters !== "number") {
        return NextResponse.json({ error: "Invalid point format" }, { status: 400 });
      }
      if (point.rawValue < 0 || point.liters < 0) {
        return NextResponse.json({ error: "Values must be non-negative" }, { status: 400 });
      }
      if (seenRawValues.has(point.rawValue)) {
        return NextResponse.json({ error: "Duplicate rawValue found" }, { status: 400 });
      }
      if (point.liters < prevLiters) {
        return NextResponse.json({ error: "Liters must be monotonically increasing" }, { status: 400 });
      }
      if (vehicle.maxFuelCapacity && point.liters > vehicle.maxFuelCapacity) {
        return NextResponse.json(
          { error: `Liters cannot exceed maxFuelCapacity (${vehicle.maxFuelCapacity})` },
          { status: 400 }
        );
      }
      seenRawValues.add(point.rawValue);
      prevLiters = point.liters;
    }

    // Atomic upsert
    await prisma.$transaction([
      prisma.fuelCalibrationPoint.deleteMany({
        where: { vehicleId },
      }),
      prisma.fuelCalibrationPoint.createMany({
        data: sortedPoints.map((p) => ({
          vehicleId,
          rawValue: p.rawValue,
          liters: p.liters,
        })),
      }),
    ]);

    // Invalidate and re-cache
    if (vehicle.device?.imei) {
      await cacheCalibrationTable(vehicle.device.imei, sortedPoints);
    }

    return NextResponse.json({
      success: true,
      message: "Fuel calibration saved successfully",
      vehicleId,
      points: sortedPoints,
    });
  } catch (error: any) {
    console.error("[API] PUT fuel-calibration-table error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ vehicleId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { vehicleId } = await params;

    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { device: true },
    });

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    if (vehicle.organizationId !== auth.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    await prisma.fuelCalibrationPoint.deleteMany({
      where: { vehicleId },
    });

    if (vehicle.device?.imei) {
      await invalidateCalibrationCache(vehicle.device.imei);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[API] DELETE fuel-calibration-table error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
