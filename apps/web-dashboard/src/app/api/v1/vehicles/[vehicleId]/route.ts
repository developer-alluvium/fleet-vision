import { NextRequest, NextResponse } from "next/server";
import {
  prisma,
  redis,
  invalidateFuelSettingsCache,
  invalidateCalibrationCache,
  getLiveMapSafe,
} from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

/**
 * GET /api/v1/vehicles/[vehicleId]
 *
 * Retrieves metadata for a specific vehicle, including its attached device
 * and fuel calibration curve points.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ vehicleId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { vehicleId } = await params;

    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: {
        device: true,
        calibrationPoints: {
          orderBy: { rawValue: "asc" },
        },
      },
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

    return NextResponse.json({ vehicle });
  } catch (error) {
    console.error(`[API] GET /api/v1/vehicles/[vehicleId] error:`, error);
    if (
      error instanceof Error &&
      (error.message.includes("Invalid token") ||
        error.message.includes("Authentication required") ||
        error.message.includes("Invalid or inactive API key"))
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

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
      dataToUpdate.speedLimitKmh =
        speedLimitKmh === null ? null : Number(speedLimitKmh);
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
    if (
      error instanceof Error &&
      (error.message.includes("Invalid token") ||
        error.message.includes("Authentication required") ||
        error.message.includes("Invalid or inactive API key"))
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/v1/vehicles/[vehicleId]
 *
 * Enterprise-grade vehicle deletion API with Safety Guardrail Checks (Failsafe):
 * 1. Multi-Tenant Authorization & RBAC Check.
 * 2. Live Motion & Ignition Guardrail: Rejects deletion if vehicle is moving or ignition is ON.
 * 3. Geofence Episode Guardrail: Rejects if vehicle has an active OPEN geofence violation episode.
 * 4. Critical Security Alert Guardrail: Rejects if vehicle has unresolved SOS / Tampering alerts.
 * 5. Atomic Deletion & Cascade Unassignment in Database Transaction.
 * 6. Redis Invalidation: Clears telemetry caches, calibration tables, and publishes fleet update.
 *
 * Query Params:
 *  - force: boolean ("true" | "false") — Allows emergency override of motion/alert guardrails.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ vehicleId: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { vehicleId } = await params;
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true";

    // ── 1. Fetch vehicle & verify organization tenancy ─────────
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: {
        device: true,
      },
    });

    if (!vehicle) {
      return NextResponse.json(
        { error: "Vehicle not found" },
        { status: 404 }
      );
    }

    if (vehicle.organizationId !== auth.organizationId) {
      return NextResponse.json(
        { error: "Unauthorized access to this vehicle" },
        { status: 403 }
      );
    }

    // Role check: Only ADMIN or MANAGER can delete fleet assets
    if (auth.role && auth.role === "VIEWER") {
      return NextResponse.json(
        { error: "Forbidden: Viewer roles cannot delete fleet vehicles" },
        { status: 403 }
      );
    }

    const imei = vehicle.device?.imei;

    // ── 2. Safety Guardrail Checks (Failsafe) ─────────────────
    if (imei && !force) {
      // Guardrail A: Live Motion & Ignition Check in Redis
      try {
        const liveMap = await getLiveMapSafe(auth.organizationId);
        const liveData = liveMap[imei] as any;

        if (liveData) {
          const isIgnitionOn = liveData.ignition === true;
          const isMoving =
            (typeof liveData.speed === "number" && liveData.speed > 3) ||
            liveData.movement === true;

          if (isIgnitionOn || isMoving) {
            return NextResponse.json(
              {
                error: `Safety Guardrail Conflict: Vehicle ${vehicle.plateNumber} is currently active or in motion.`,
                code: "VEHICLE_IN_MOTION",
                details: {
                  plateNumber: vehicle.plateNumber,
                  imei,
                  speed: liveData.speed ?? 0,
                  ignition: isIgnitionOn,
                  lastSeen: liveData.timestamp || liveData.time || new Date().toISOString(),
                  recommendation:
                    "Ensure the vehicle is stationary with ignition turned OFF before deleting, or specify ?force=true for emergency override.",
                },
              },
              { status: 409 }
            );
          }
        }
      } catch (cacheErr) {
        console.warn("[DELETE Vehicle] Live map check non-blocking warning:", cacheErr);
      }

      // Guardrail B: Active Geofence Violation Episodes
      const activeEpisode = await prisma.geofenceViolationEpisode.findFirst({
        where: {
          imei,
          organizationId: auth.organizationId,
          status: "OPEN",
        },
        include: {
          geofence: { select: { name: true } },
        },
      });

      if (activeEpisode) {
        return NextResponse.json(
          {
            error: `Safety Guardrail Conflict: Vehicle ${vehicle.plateNumber} has an active open geofence violation episode in "${activeEpisode.geofence?.name || "monitored zone"}".`,
            code: "ACTIVE_GEOFENCE_VIOLATION",
            details: {
              episodeId: activeEpisode.id,
              geofenceName: activeEpisode.geofence?.name,
              peakSpeedKmh: activeEpisode.peakSpeedKmh,
              startedAt: activeEpisode.startedAt,
              recommendation:
                "Resolve or close the ongoing geofence speeding incident before deletion, or use ?force=true.",
            },
          },
          { status: 409 }
        );
      }

      // Guardrail C: Unresolved Critical Security Alerts (SOS / Tampering)
      const unresolvedAlert = await prisma.alert.findFirst({
        where: {
          imei,
          organizationId: auth.organizationId,
          category: { in: ["SOS", "TAMPERING"] },
          resolvedAt: null,
        },
        orderBy: { createdAt: "desc" },
      });

      if (unresolvedAlert) {
        return NextResponse.json(
          {
            error: `Safety Guardrail Conflict: Vehicle ${vehicle.plateNumber} has an unresolved critical security alert (${unresolvedAlert.category}).`,
            code: "UNRESOLVED_CRITICAL_ALERT",
            details: {
              alertId: unresolvedAlert.id,
              category: unresolvedAlert.category,
              eventType: unresolvedAlert.eventType,
              timestamp: unresolvedAlert.timestamp,
              recommendation:
                "Acknowledge and resolve this security alert in the Alert Center before deletion, or use ?force=true.",
            },
          },
          { status: 409 }
        );
      }
    }

    // ── 3. Atomic Database Operations (Transaction) ───────────
    const transactionResult = await prisma.$transaction(async (tx) => {
      let unassignedDevice = null;

      // Unassign attached tracking device so hardware returns cleanly to inventory pool
      if (vehicle.device) {
        unassignedDevice = await tx.device.update({
          where: { id: vehicle.device.id },
          data: {
            vehicleId: null,
            status: "PENDING_CONNECTION",
          },
        });
      }

      // Delete associated BLE calibration points
      await tx.fuelCalibrationPoint.deleteMany({
        where: { vehicleId },
      });

      // Delete the vehicle entity
      const deleted = await tx.vehicle.delete({
        where: { id: vehicleId },
      });

      return { deleted, unassignedDevice };
    });

    // ── 4. Cache & Real-Time Invalidation ─────────────────────
    if (imei) {
      Promise.allSettled([
        invalidateFuelSettingsCache(imei),
        invalidateCalibrationCache(imei),
        // Update Redis live map to detach vehicle metadata from active device
        (async () => {
          try {
            const liveMap = await getLiveMapSafe(auth.organizationId);
            const liveData = liveMap[imei] as any;
            if (liveData && liveData.vehicle) {
              delete liveData.vehicle;
              await redis.hset(
                `live_map:org:${auth.organizationId}`,
                imei,
                JSON.stringify(liveData)
              );
            }
          } catch (e) {
            console.error("[DELETE Vehicle] Live map cache update error:", e);
          }
        })(),
        // Publish real-time notification to fleet status SSE stream
        redis.publish(
          `fleet_status:org:${auth.organizationId}`,
          JSON.stringify({
            type: "VEHICLE_DELETED",
            vehicleId,
            plateNumber: vehicle.plateNumber,
            unassignedImei: imei,
            timestamp: new Date().toISOString(),
          })
        ),
      ]).catch((e) => console.error("[DELETE Vehicle] Post-commit error:", e));
    }

    return NextResponse.json(
      {
        success: true,
        message: `Vehicle ${vehicle.plateNumber} deleted successfully.`,
        deletedVehicle: {
          id: transactionResult.deleted.id,
          plateNumber: transactionResult.deleted.plateNumber,
          unassignedDeviceId: transactionResult.unassignedDevice?.id || null,
          unassignedImei: transactionResult.unassignedDevice?.imei || null,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error(`[API] DELETE /api/v1/vehicles/[vehicleId] error:`, error);
    if (
      error instanceof Error &&
      (error.message.includes("Invalid token") ||
        error.message.includes("Authentication required") ||
        error.message.includes("Invalid or inactive API key"))
    ) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
