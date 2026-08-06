import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

/**
 * POST /api/v1/vehicles
 *
 * Registers a new vehicle.
 *
 * Request body:
 *   { plateNumber, make, model, year, color, vin, vehicleType, status, fuelType, maxFuelCapacity, orgId }
 *
 * Response:
 *   201 — { vehicle }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid or missing JSON payload" },
        { status: 400 }
      );
    }

    const {
      plateNumber,
      make,
      model,
      year,
      color,
      vin,
      vehicleType,
      status,
      fuelType,
      maxFuelCapacity,
      orgId,
    } = body || {};

    // Check authorization matches orgId
    if (orgId && auth.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Unauthorized access to this organization" },
        { status: 403 }
      );
    }

    // Use orgId from auth if not provided in body
    const targetOrgId = orgId || auth.organizationId;

    // ── Validation ─────────────────────────────────────────
    if (!plateNumber || typeof plateNumber !== "string" || plateNumber.trim().length === 0) {
      return NextResponse.json(
        { error: "plateNumber is required" },
        { status: 400 }
      );
    }

    if (!targetOrgId || typeof targetOrgId !== "string") {
      return NextResponse.json(
        { error: "orgId is required" },
        { status: 400 }
      );
    }

    // ── Verify org exists ──────────────────────────────────
    const org = await prisma.organization.findUnique({
      where: { id: targetOrgId },
    });
    if (!org) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 }
      );
    }

    if (org.status !== "ACTIVE") {
      return NextResponse.json(
        { error: "Organization is not active" },
        { status: 403 }
      );
    }

    // ── Check for duplicate plateNumber or VIN ─────────────
    const existingVehicle = await prisma.vehicle.findFirst({
      where: {
        OR: [
          { plateNumber: plateNumber.trim() },
          ...(vin && typeof vin === "string" && vin.trim().length > 0 ? [{ vin: vin.trim() }] : []),
        ],
      },
    });

    if (existingVehicle) {
      if (existingVehicle.plateNumber === plateNumber.trim()) {
        return NextResponse.json(
          { error: "A vehicle with this plate number already exists" },
          { status: 409 }
        );
      }
      if (vin && existingVehicle.vin === vin.trim()) {
        return NextResponse.json(
          { error: "A vehicle with this VIN already exists" },
          { status: 409 }
        );
      }
    }

    // ── Create Vehicle in PostgreSQL ────────────────────────
    const parsedYear = year ? (typeof year === "number" ? year : parseInt(year, 10)) : null;
    const parsedMaxFuel = maxFuelCapacity ? (typeof maxFuelCapacity === "number" ? maxFuelCapacity : parseFloat(maxFuelCapacity)) : null;

    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: plateNumber.trim(),
        make: make && typeof make === "string" ? make.trim() : null,
        model: model && typeof model === "string" ? model.trim() : null,
        year: isNaN(parsedYear as number) ? null : parsedYear,
        color: color && typeof color === "string" ? color.trim() : null,
        vin: vin && typeof vin === "string" && vin.trim().length > 0 ? vin.trim() : null,
        vehicleType: vehicleType && typeof vehicleType === "string" ? vehicleType.trim() : null,
        status: status && typeof status === "string" ? status.trim() : "ACTIVE",
        fuelType: fuelType && typeof fuelType === "string" ? fuelType.trim() : null,
        maxFuelCapacity: isNaN(parsedMaxFuel as number) ? null : parsedMaxFuel,
        organizationId: targetOrgId,
      },
    });

    return NextResponse.json({ vehicle }, { status: 201 });
  } catch (error: any) {
    console.error("[API] POST /api/v1/vehicles error:", error);
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

/**
 * GET /api/v1/vehicles?orgId=xxx
 *
 * Lists all vehicles for an organization.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get("orgId") || auth.organizationId;

    // Check authorization matches orgId
    if (orgId && auth.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Unauthorized access to this organization" },
        { status: 403 }
      );
    }

    if (!orgId) {
      return NextResponse.json(
        { error: "orgId query parameter is required" },
        { status: 400 }
      );
    }

    const vehicles = await prisma.vehicle.findMany({
      where: { organizationId: orgId },
      include: { device: true },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ vehicles });
  } catch (error: any) {
    console.error("[API] GET /api/v1/vehicles error:", error);
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
