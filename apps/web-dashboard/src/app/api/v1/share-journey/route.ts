import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { prisma } from "@fleet-vision/db";
import { generateShareToken } from "@/lib/shareJourney";

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    // RBAC: Viewers cannot create share links
    if (auth.role === "VIEWER") {
      return NextResponse.json(
        { error: "Forbidden: Viewer accounts cannot create shared journey links" },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { vehicleId, imei, durationHours, label, showSpeed, showVehicleInfo } = body;

    if (
      (!vehicleId || typeof vehicleId !== "string") &&
      (!imei || typeof imei !== "string")
    ) {
      return NextResponse.json(
        { error: "vehicleId or imei is required" },
        { status: 400 }
      );
    }

    const duration = Number(durationHours);
    if (isNaN(duration) || !isFinite(duration) || duration <= 0) {
      return NextResponse.json(
        { error: "durationHours must be a valid positive number" },
        { status: 400 }
      );
    }

    // Check organization settings for maximum allowed share duration
    const org = await prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { maxShareDurationHours: true },
    });

    const maxAllowedHours = org?.maxShareDurationHours ?? 72;
    if (duration > maxAllowedHours) {
      return NextResponse.json(
        {
          error: `Share duration exceeds organization maximum allowed limit of ${maxAllowedHours} hours`,
        },
        { status: 400 }
      );
    }

    if (duration < 0.25) {
      return NextResponse.json(
        { error: "Minimum share duration is 0.25 hours (15 minutes)" },
        { status: 400 }
      );
    }

    // Verify vehicle belongs to user's organization and has a hardware device assigned
    let vehicle = null;
    if (vehicleId) {
      vehicle = await prisma.vehicle.findUnique({
        where: { id: vehicleId },
        include: { device: true },
      });
    } else if (imei) {
      const dev = await prisma.device.findUnique({
        where: { imei },
        include: { vehicle: { include: { device: true } } },
      });
      if (!dev) {
        return NextResponse.json(
          { error: "No tracker hardware found with this IMEI" },
          { status: 404 }
        );
      }
      if (!dev.vehicle) {
        return NextResponse.json(
          { error: "This GPS hardware is not currently assigned to any vehicle" },
          { status: 400 }
        );
      }
      vehicle = dev.vehicle;
    }

    if (!vehicle || vehicle.organizationId !== auth.organizationId) {
      return NextResponse.json(
        { error: "Vehicle not found in your organization" },
        { status: 404 }
      );
    }

    if (!vehicle.device?.imei) {
      return NextResponse.json(
        { error: "Vehicle does not have an active GPS tracker assigned" },
        { status: 400 }
      );
    }

    // Cryptographic token generation
    const { rawToken, tokenHash } = generateShareToken();
    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + duration * 3600 * 1000);

    const share = await prisma.sharedJourney.create({
      data: {
        tokenHash,
        organizationId: auth.organizationId,
        vehicleId: vehicle.id,
        startsAt,
        expiresAt,
        label: label ? String(label).trim().slice(0, 100) : null,
        createdBy: auth.userId || "api-key",
        showSpeed: showSpeed !== false,
        showVehicleInfo: showVehicleInfo !== false,
      },
    });

    // Derive frontend public tracker URL
    const publicTrackerBase =
      process.env.PUBLIC_TRACKER_URL ||
      request.headers.get("origin") ||
      "http://localhost:8080";

    const shareUrl = `${publicTrackerBase.replace(/\/$/, "")}/shared/${rawToken}`;

    return NextResponse.json(
      {
        shareId: share.id,
        rawToken,
        shareUrl,
        vehicle: {
          id: vehicle.id,
          plateNumber: vehicle.plateNumber,
          make: vehicle.make,
          model: vehicle.model,
          vehicleType: vehicle.vehicleType,
        },
        label: share.label,
        startsAt: share.startsAt.toISOString(),
        expiresAt: share.expiresAt.toISOString(),
        durationHours: duration,
        status: "ACTIVE",
        showSpeed: share.showSpeed,
        showVehicleInfo: share.showVehicleInfo,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("[API] POST /api/v1/share-journey error:", error);
    if (
      error.message?.includes("Authentication required") ||
      error.message?.includes("Invalid token") ||
      error.message?.includes("Invalid or inactive API key")
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    const { searchParams } = new URL(request.url);
    const vehicleId = searchParams.get("vehicleId");
    const statusFilter = searchParams.get("status")?.toUpperCase(); // ACTIVE, EXPIRED, REVOKED, ALL
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10) || 20));

    const where: any = {
      organizationId: auth.organizationId,
    };

    if (vehicleId) {
      where.vehicleId = vehicleId;
    }

    if (statusFilter && statusFilter !== "ALL") {
      if (statusFilter === "REVOKED") {
        where.status = "REVOKED";
      } else if (statusFilter === "ACTIVE") {
        where.status = "ACTIVE";
        where.expiresAt = { gt: new Date() };
      } else if (statusFilter === "EXPIRED") {
        where.status = "ACTIVE";
        where.expiresAt = { lte: new Date() };
      }
    }

    const [total, shares] = await Promise.all([
      prisma.sharedJourney.count({ where }),
      prisma.sharedJourney.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          vehicle: {
            select: {
              id: true,
              plateNumber: true,
              make: true,
              model: true,
              vehicleType: true,
            },
          },
        },
      }),
    ]);

    const now = new Date();
    const formattedShares = shares.map((s) => {
      let computedStatus: "ACTIVE" | "EXPIRED" | "REVOKED" = "ACTIVE";
      if (s.status === "REVOKED") {
        computedStatus = "REVOKED";
      } else if (s.expiresAt.getTime() <= now.getTime()) {
        computedStatus = "EXPIRED";
      }

      const remainingMs = Math.max(0, s.expiresAt.getTime() - now.getTime());

      return {
        id: s.id,
        vehicleId: s.vehicleId,
        vehiclePlate: s.vehicle.plateNumber,
        vehicleMake: s.vehicle.make,
        vehicleModel: s.vehicle.model,
        vehicleType: s.vehicle.vehicleType,
        label: s.label,
        status: computedStatus,
        startsAt: s.startsAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        remainingMinutes: Math.floor(remainingMs / 60000),
        accessCount: s.accessCount,
        lastAccessedAt: s.lastAccessedAt ? s.lastAccessedAt.toISOString() : null,
        showSpeed: s.showSpeed,
        showVehicleInfo: s.showVehicleInfo,
        createdAt: s.createdAt.toISOString(),
      };
    });

    return NextResponse.json({
      shares: formattedShares,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error("[API] GET /api/v1/share-journey error:", error);
    if (
      error.message?.includes("Authentication required") ||
      error.message?.includes("Invalid token") ||
      error.message?.includes("Invalid or inactive API key")
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
