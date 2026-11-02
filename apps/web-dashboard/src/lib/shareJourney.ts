import crypto from "crypto";
import { prisma } from "@fleet-vision/db";

/**
 * Hash a raw token using SHA-256 for secure database lookup.
 */
export function hashShareToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Generate a cryptographically secure 256-bit raw token and its SHA-256 hash.
 */
export function generateShareToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashShareToken(rawToken);
  return { rawToken, tokenHash };
}

/**
 * Enterprise security headers applied to all public share responses.
 * Enforces no indexing, no referrer leakage, and strictly forbids caching of live tracking state.
 */
export const SHARE_SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

export type ResolveShareResult =
  | {
      success: true;
      share: {
        id: string;
        tokenHash: string;
        organizationId: string;
        vehicleId: string;
        startsAt: Date;
        expiresAt: Date;
        status: string;
        label: string | null;
        showSpeed: boolean;
        showVehicleInfo: boolean;
        accessCount: number;
      };
      vehicle: {
        id: string;
        plateNumber: string;
        make: string | null;
        model: string | null;
        vehicleType: string | null;
        status: string;
      };
      device: {
        id: string;
        imei: string;
        status: string;
      };
      imei: string;
    }
  | {
      success: false;
      error: string;
      status: number;
    };

export interface ResolveShareOptions {
  incrementAccessCount?: boolean;
}

/**
 * Validates and loads an active share session by raw token.
 * Performs all enterprise security and tenant isolation checks:
 * 1. Hashes token and performs DB lookup.
 * 2. Validates share status and expiry.
 * 3. Verifies tenant isolation (vehicle belongs to share organization).
 * 4. Ensures vehicle has an active tracking device attached.
 * 5. Optionally increments access metrics with a cooldown to prevent duplicate counting.
 */
export async function resolveShare(
  rawToken: string,
  options?: ResolveShareOptions
): Promise<ResolveShareResult> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.trim().length === 0) {
    return { success: false, error: "Share token is required", status: 400 };
  }

  const tokenHash = hashShareToken(rawToken.trim());

  const share = await prisma.sharedJourney.findUnique({
    where: { tokenHash },
    include: {
      organization: {
        select: {
          id: true,
          status: true,
        },
      },
      vehicle: {
        include: {
          device: true,
        },
      },
    },
  });

  if (!share) {
    return { success: false, error: "Shared journey link not found", status: 404 };
  }

  // Check revocation status
  if (share.status === "REVOKED") {
    return { success: false, error: "This shared journey has been revoked", status: 410 };
  }

  // Check expiration time
  const now = new Date();
  if (share.expiresAt.getTime() <= now.getTime()) {
    return { success: false, error: "This shared journey link has expired", status: 410 };
  }

  // Check organization status
  if (share.organization.status !== "ACTIVE") {
    return { success: false, error: "Organization account is inactive", status: 403 };
  }

  // Tenant Isolation Guardrail: Ensure vehicle still belongs to the share's organization
  if (share.vehicle.organizationId !== share.organizationId) {
    return { success: false, error: "Vehicle organization mismatch", status: 403 };
  }

  // Check active device assignment
  if (!share.vehicle.device || !share.vehicle.device.imei) {
    return {
      success: false,
      error: "No GPS tracking hardware currently assigned to this vehicle",
      status: 404,
    };
  }

  // Increment access metrics ONLY when explicitly requested (page visit), NOT during background SSE stream connections.
  // Apply a 10-second cooldown so React StrictMode or instant double-renders only count as 1 view.
  if (options?.incrementAccessCount) {
    const isNewVisit =
      !share.lastAccessedAt ||
      now.getTime() - share.lastAccessedAt.getTime() > 10000;

    if (isNewVisit) {
      prisma.sharedJourney
        .update({
          where: { id: share.id },
          data: {
            accessCount: { increment: 1 },
            lastAccessedAt: now,
          },
        })
        .catch((err) => {
          console.error("[resolveShare] Failed to update access stats:", err);
        });
    }
  }

  return {
    success: true,
    share: {
      id: share.id,
      tokenHash: share.tokenHash,
      organizationId: share.organizationId,
      vehicleId: share.vehicleId,
      startsAt: share.startsAt,
      expiresAt: share.expiresAt,
      status: share.status,
      label: share.label,
      showSpeed: share.showSpeed,
      showVehicleInfo: share.showVehicleInfo,
      accessCount: share.accessCount,
    },
    vehicle: {
      id: share.vehicle.id,
      plateNumber: share.vehicle.plateNumber,
      make: share.vehicle.make,
      model: share.vehicle.model,
      vehicleType: share.vehicle.vehicleType,
      status: share.vehicle.status,
    },
    device: {
      id: share.vehicle.device.id,
      imei: share.vehicle.device.imei,
      status: share.vehicle.device.status,
    },
    imei: share.vehicle.device.imei,
  };
}
