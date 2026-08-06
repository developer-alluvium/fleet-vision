import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

/**
 * POST /api/v1/devices/[deviceId]/assign
 *
 * Assigns a vehicle to a GPS tracking device.
 *
 * Request body:
 *   { vehicleId: string | null }
 *
 * Response:
 *   200 — { device }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> | { deviceId: string } }
) {
  try {
    const auth = await authenticate(request);

    const resolvedParams = await params;
    const deviceId = resolvedParams.deviceId;

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // Body can be empty if unassigning or if body is missing
    }
    const { vehicleId } = body;

    // ── Verify Device exists ────────────────────────────────
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device) {
      return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    // Check authorization matches orgId
    if (auth.organizationId !== device.organizationId) {
      return NextResponse.json(
        { error: "Unauthorized access to this device's organization" },
        { status: 403 }
      );
    }

    // ── Handle unassign ─────────────────────────────────────
    if (vehicleId === null || vehicleId === undefined) {
      const updatedDevice = await prisma.device.update({
        where: { id: deviceId },
        data: { vehicleId: null },
        include: { vehicle: true },
      });
      return NextResponse.json({ device: updatedDevice }, { status: 200 });
    }

    // ── Verify Vehicle exists and belongs to the same org ───
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });

    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    if (vehicle.organizationId !== device.organizationId) {
      return NextResponse.json(
        { error: "Vehicle belongs to a different organization" },
        { status: 400 }
      );
    }

    // ── Update Device ───────────────────────────────────────
    const updatedDevice = await prisma.device.update({
      where: { id: deviceId },
      data: { vehicleId: vehicle.id },
      include: { vehicle: true },
    });

    return NextResponse.json({ device: updatedDevice }, { status: 200 });
  } catch (error: any) {
    console.error("[API] POST /api/v1/devices/[deviceId]/assign error:", error);
    
    // Check for Prisma unique constraint violation on vehicleId
    if (error.code === 'P2002' && error.meta?.target?.includes('vehicle_id')) {
      return NextResponse.json(
        { error: "This vehicle is already assigned to another device" },
        { status: 409 }
      );
    }

    if (
      error.message &&
      (error.message.includes("Authentication required") ||
        error.message.includes("Invalid token") ||
        error.message.includes("API key"))
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
