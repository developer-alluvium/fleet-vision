import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import { authenticate } from "@/lib/auth";
import crypto from "crypto";

/**
 * POST /api/v1/organizations/api-key
 * Generates a new API key for the organization.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    // Only allow JWT authentication to generate API keys (not another API key)
    if (auth.type !== "jwt") {
      return NextResponse.json(
        { error: "Must be logged in as a user to generate an API key" },
        { status: 403 }
      );
    }

    // Generate a random API key (32 bytes -> 64 hex chars)
    const newApiKey = `fv_live_${crypto.randomBytes(32).toString("hex")}`;

    const updatedOrg = await prisma.organization.update({
      where: { id: auth.organizationId },
      data: { apiKey: newApiKey },
      select: { apiKey: true },
    });

    return NextResponse.json({ apiKey: updatedOrg.apiKey }, { status: 201 });
  } catch (error: any) {
    console.error("[API] POST /api/v1/organizations/api-key error:", error);
    if (error.message.includes("Authentication required") || error.message.includes("Invalid token")) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * GET /api/v1/organizations/api-key
 * Returns the currently stored API key.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    if (auth.type !== "jwt") {
      return NextResponse.json(
        { error: "Must be logged in as a user to view the API key" },
        { status: 403 }
      );
    }

    const org = await prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { apiKey: true },
    });

    return NextResponse.json({ apiKey: org?.apiKey || null });
  } catch (error: any) {
    console.error("[API] GET /api/v1/organizations/api-key error:", error);
    if (error.message.includes("Authentication required") || error.message.includes("Invalid token")) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
