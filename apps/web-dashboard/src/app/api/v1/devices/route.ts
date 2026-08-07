import { NextRequest, NextResponse } from "next/server";
import { prisma, authorizeDevice } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

/**
 * POST /api/v1/devices
 *
 * Registers a new device and syncs it to the Redis auth cache.
 *
 * Request body:
 *   { imei: string, orgId: string }
 *
 * Response:
 *   201 — { device }
 *
 * CRITICAL: After creating the device in PostgreSQL, this endpoint
 * writes `auth:{imei}` to Redis so the data-processor can authenticate
 * incoming telemetry packets in O(1).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    const body = await request.json();
    const { imei, orgId } = body;

    // Check authorization matches orgId
    if (auth.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Unauthorized access to this organization" },
        { status: 403 }
      );
    }

    // ── Validation ─────────────────────────────────────────
    if (!imei || typeof imei !== "string" || imei.trim().length !== 15) {
      return NextResponse.json(
        { error: "imei is required and must be a 15-digit string" },
        { status: 400 }
      );
    }

    if (!orgId || typeof orgId !== "string") {
      return NextResponse.json(
        { error: "orgId is required" },
        { status: 400 }
      );
    }

    // Validate IMEI is all digits
    if (!/^\d{15}$/.test(imei.trim())) {
      return NextResponse.json(
        { error: "imei must contain exactly 15 digits" },
        { status: 400 }
      );
    }

    // ── Verify org exists ──────────────────────────────────
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
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

    // ── Check for duplicate IMEI ───────────────────────────
    const existingDevice = await prisma.device.findUnique({
      where: { imei: imei.trim() },
    });
    if (existingDevice) {
      return NextResponse.json(
        { error: "A device with this IMEI is already registered" },
        { status: 409 }
      );
    }

    // ── Create Device in PostgreSQL ────────────────────────
    const device = await prisma.device.create({
      data: {
        imei: imei.trim(),
        organizationId: orgId,
      },
    });

    // ── CRITICAL: Sync to Redis Auth Cache ─────────────────
    await authorizeDevice(device.imei, orgId);
    console.log(
      `[API] ✓ Device ${device.imei} authorized in Redis for org ${orgId}`
    );

    return NextResponse.json({ device }, { status: 201 });
  } catch (error: any) {
    console.error("[API] POST /api/v1/devices error:", error);
    if (error.message && (error.message.includes("Authentication required") || error.message.includes("Invalid token") || error.message.includes("API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v1/devices?orgId=xxx
 *
 * Lists all devices for an organization.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    const { searchParams } = new URL(request.url);
    let orgId = searchParams.get("orgId");

    // Check authorization matches orgId if provided
    if (orgId && auth.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Unauthorized access to this organization" },
        { status: 403 }
      );
    }

    // Use orgId from auth if not provided
    orgId = orgId || auth.organizationId;

    if (!orgId) {
      return NextResponse.json(
        { error: "orgId is required and could not be determined from authentication" },
        { status: 400 }
      );
    }

    const devices = await prisma.device.findMany({
      where: { organizationId: orgId },
      include: { vehicle: true },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ devices });
  } catch (error: any) {
    console.error("[API] GET /api/v1/devices error:", error);
    if (error.message && (error.message.includes("Authentication required") || error.message.includes("Invalid token") || error.message.includes("API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
