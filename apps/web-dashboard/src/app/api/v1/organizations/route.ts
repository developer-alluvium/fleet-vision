import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";
import bcrypt from "bcryptjs";

/**
 * POST /api/v1/organizations
 *
 * Creates a new Organization and its initial Admin User.
 *
 * Request body:
 *   { name: string, adminEmail: string }
 *
 * Response:
 *   201 — { organization, user }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, adminEmail, password } = body;

    // ── Validation ─────────────────────────────────────────
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "name is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    if (
      !adminEmail ||
      typeof adminEmail !== "string" ||
      !adminEmail.includes("@")
    ) {
      return NextResponse.json(
        { error: "adminEmail is required and must be a valid email" },
        { status: 400 }
      );
    }

    // ── Check for duplicate email ──────────────────────────
    const existingUser = await prisma.user.findUnique({
      where: { email: adminEmail },
    });
    if (existingUser) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 409 }
      );
    }

    // ── Create Org + Admin User in a single transaction ────
    const result = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: name.trim(),
        },
      });

      // Hash the password if provided, otherwise leave it null (or we could enforce it)
      // Since it's a new feature, let's enforce it if provided, or generate a dummy one if not
      // to not break existing clients
      let passwordHash = null;
      if (password && typeof password === "string" && password.length >= 6) {
        passwordHash = await bcrypt.hash(password, 10);
      } else if (password) {
        throw new Error("Password must be at least 6 characters");
      }

      const user = await tx.user.create({
        data: {
          email: adminEmail.toLowerCase().trim(),
          password: passwordHash,
          role: "ADMIN",
          organizationId: organization.id,
        },
      });

      return { organization, user };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("[API] POST /api/v1/organizations error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v1/organizations
 *
 * Lists all organizations (admin/debug endpoint).
 */
export async function GET() {
  try {
    const organizations = await prisma.organization.findMany({
      include: {
        _count: {
          select: { users: true, devices: true, vehicles: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ organizations });
  } catch (error) {
    console.error("[API] GET /api/v1/organizations error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
