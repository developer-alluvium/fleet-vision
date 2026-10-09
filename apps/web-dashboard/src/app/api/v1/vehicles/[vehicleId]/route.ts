import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

/**
 * PATCH /api/v1/vehicles/[vehicleId]
 *
 * Updates a vehicle's properties (e.g., speedLimitKmh override).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ vehicleId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { vehicleId } = await params;

    // Verify vehicle belongs to user's organization
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    if (vehicle.organizationId !== auth.organizationId) {
      return NextResponse.json(
        { error: "Unauthorized access to this vehicle" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { speedLimitKmh } = body;

    const dataToUpdate: any = {};
    if (speedLimitKmh !== undefined) {
      dataToUpdate.speedLimitKmh = speedLimitKmh === null ? null : Number(speedLimitKmh);
    }

    if (Object.keys(dataToUpdate).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const updatedVehicle = await prisma.vehicle.update({
      where: { id: vehicleId },
      data: dataToUpdate,
    });

    return NextResponse.json({ vehicle: updatedVehicle });
  } catch (error) {
    console.error(`[API] PATCH /api/v1/vehicles/[vehicleId] error:`, error);
    if (error instanceof Error && (error.message.includes("Invalid token") || error.message.includes("Authentication required") || error.message.includes("Invalid or inactive API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
