import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";

/**
 * GET /api/v1/organizations/[id]
 *
 * Fetches detailed organization information, including relation counts.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { id } = await params;

    // Verify user belongs to the requested organization
    if (auth.organizationId !== id) {
      return NextResponse.json(
        { error: "Unauthorized access to this organization" },
        { status: 403 }
      );
    }

    const organization = await prisma.organization.findUnique({
      where: { id },
      include: {
        _count: {
          select: { users: true, devices: true, vehicles: true, geofences: true },
        },
      },
    });

    if (!organization) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 }
      );
    }

    // Prepare response data
    const orgData: any = {
      ...organization,
    };

    // Filter sensitive fields unless user is ADMIN or using api-key
    // API keys act on behalf of the organization
    if (auth.role !== "ADMIN" && auth.type !== "api-key") {
      delete orgData.apiKey;
      delete orgData.stripeCustomerId;
    }

    return NextResponse.json({ organization: orgData });
  } catch (error) {
    console.error(`[API] GET /api/v1/organizations/[id] error:`, error);
    // If the error was thrown by authenticate, it will usually have a specific message,
    // but returning 401/500 depending on if it's auth related is better handled below:
    if (error instanceof Error && (error.message.includes("Invalid token") || error.message.includes("Authentication required") || error.message.includes("Invalid or inactive API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/v1/organizations/[id]
 *
 * Updates organization settings, such as globalSpeedLimitKmh.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticate(request);
    const { id } = await params;

    // Verify user belongs to the requested organization and is ADMIN
    if (auth.organizationId !== id) {
      return NextResponse.json(
        { error: "Unauthorized access to this organization" },
        { status: 403 }
      );
    }

    if (auth.role !== "ADMIN" && auth.type !== "api-key") {
      return NextResponse.json(
        { error: "Admin privileges required to update organization settings" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { globalSpeedLimitKmh } = body;

    const dataToUpdate: any = {};
    if (globalSpeedLimitKmh !== undefined) {
      dataToUpdate.globalSpeedLimitKmh = globalSpeedLimitKmh === null ? null : Number(globalSpeedLimitKmh);
    }

    if (Object.keys(dataToUpdate).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const organization = await prisma.organization.update({
      where: { id },
      data: dataToUpdate,
    });

    const orgData: any = { ...organization };
    if (auth.role !== "ADMIN" && auth.type !== "api-key") {
      delete orgData.apiKey;
      delete orgData.stripeCustomerId;
    }

    return NextResponse.json({ organization: orgData });
  } catch (error) {
    console.error(`[API] PATCH /api/v1/organizations/[id] error:`, error);
    if (error instanceof Error && (error.message.includes("Invalid token") || error.message.includes("Authentication required") || error.message.includes("Invalid or inactive API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

