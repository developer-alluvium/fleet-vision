import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { prisma } from "@fleet-vision/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await authenticate(request);
    const { id } = await params;

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Share ID is required" }, { status: 400 });
    }

    const share = await prisma.sharedJourney.findUnique({
      where: { id },
    });

    if (!share) {
      return NextResponse.json(
        { error: "Shared journey link not found" },
        { status: 404 }
      );
    }

    // Tenant isolation: strict barrier
    if (share.organizationId !== auth.organizationId) {
      return NextResponse.json(
        { error: "Shared journey link not found" },
        { status: 404 }
      );
    }

    // Role check:
    // Viewers cannot revoke
    // Admins can revoke any share in their org
    // Managers can only revoke their own created shares
    if (auth.role === "VIEWER") {
      return NextResponse.json(
        { error: "Forbidden: Viewer accounts cannot revoke share links" },
        { status: 403 }
      );
    }

    if (auth.role && auth.role !== "ADMIN" && share.createdBy !== auth.userId) {
      return NextResponse.json(
        { error: "Forbidden: You can only revoke share links created by your account" },
        { status: 403 }
      );
    }

    if (share.status === "REVOKED") {
      return NextResponse.json(
        { message: "Share link is already revoked", shareId: id, status: "REVOKED" },
        { status: 200 }
      );
    }

    const updated = await prisma.sharedJourney.update({
      where: { id },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedBy: auth.userId || "api-key",
      },
    });

    return NextResponse.json({
      success: true,
      message: "Shared journey link revoked successfully",
      shareId: updated.id,
      status: updated.status,
      revokedAt: updated.revokedAt?.toISOString(),
    });
  } catch (error: any) {
    console.error("[API] DELETE /api/v1/share-journey/[id] error:", error);
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
