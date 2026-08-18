import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateFuelSettingsCache } from "@fleet-vision/db";
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
      include: { device: true },
    });

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    if (vehicle.organizationId !== auth.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    return NextResponse.json({
      vehicleId: vehicle.id,
      bleFuelChannel: vehicle.bleFuelChannel,
    });
  } catch (error: any) {
    console.error("[API] GET fuel-calibration error:", error);
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

    const { bleFuelChannel } = body;

    const updatedVehicle = await prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        bleFuelChannel,
      },
    });

    // Invalidate the cache so the data-processor picks up the new calibration
    if (vehicle.device?.imei) {
      await invalidateFuelSettingsCache(vehicle.device.imei);
    }

    return NextResponse.json({ vehicle: updatedVehicle });
  } catch (error: any) {
    console.error("[API] PUT fuel-calibration error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
