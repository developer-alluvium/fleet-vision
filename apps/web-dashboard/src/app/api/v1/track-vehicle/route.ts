import { NextRequest, NextResponse } from "next/server";
import { prisma, getLiveLocationsByImeis } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

/**
 * POST /api/v1/track-vehicle
 *
 * Fetches the current live locations for a specific batch of devices using their IMEIs.
 * Designed for 3rd-party integrations (like LR tracking).
 *
 * Request body:
 *   { imeis: ["353456789012345", ...] }
 *
 * Response:
 *   200 — { results: [ { imei, found, location } ] }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const orgId = auth.organizationId;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const { imeis } = body;

    // ── 1. Validation ──────────────────────────────────────
    if (!Array.isArray(imeis) || imeis.length === 0) {
      return NextResponse.json(
        { error: "imeis must be a non-empty array of strings" },
        { status: 400 }
      );
    }

    if (imeis.length > 50) {
      return NextResponse.json(
        { error: "Maximum 50 IMEIs allowed per request" },
        { status: 400 }
      );
    }

    for (const imei of imeis) {
      if (typeof imei !== "string" || imei.length !== 15 || !/^\d+$/.test(imei)) {
        return NextResponse.json(
          { error: `Invalid IMEI format: ${imei}. Must be a 15-digit string.` },
          { status: 400 }
        );
      }
    }

    // Remove duplicates
    const uniqueImeis = Array.from(new Set(imeis));

    // ── 2. Cross-Tenant Check ──────────────────────────────
    // Ensure all requested IMEIs actually belong to the caller's organization
    const validDevices = await prisma.device.findMany({
      where: {
        imei: { in: uniqueImeis },
        organizationId: orgId,
      },
      select: { imei: true },
    });

    const validImeis = validDevices.map((d) => d.imei);
    const unauthorizedImeis = uniqueImeis.filter((i) => !validImeis.includes(i));

    if (unauthorizedImeis.length > 0) {
      return NextResponse.json(
        {
          error: "Unauthorized access to one or more devices",
          unauthorizedImeis,
        },
        { status: 403 }
      );
    }

    // ── 3. Fetch Locations from Redis ──────────────────────
    const locationsMap = await getLiveLocationsByImeis(orgId, validImeis);

    const results = validImeis.map((imei) => {
      const loc = locationsMap[imei];
      return {
        imei,
        found: loc !== null,
        location: loc,
      };
    });

    return NextResponse.json({ results });
  } catch (error: any) {
    if (
      error.message === "Invalid token" ||
      error.message.includes("Authentication required") ||
      error.message.includes("Invalid or inactive API key")
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    console.error("[API] POST /api/v1/track-vehicle error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
