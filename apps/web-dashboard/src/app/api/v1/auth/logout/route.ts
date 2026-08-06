import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@fleet-vision/db";

export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get("refreshToken")?.value;

    if (refreshToken) {
      // Attempt to revoke the token in the database
      try {
        await prisma.refreshToken.delete({
          where: { token: refreshToken },
        });
      } catch (err) {
        // If token doesn't exist, ignore the error and proceed to clear cookies
      }
    }

    const response = NextResponse.json({ success: true });

    // Clear access token
    response.cookies.set("accessToken", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0, 
    });

    // Clear refresh token
    response.cookies.set("refreshToken", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });

    return response;
  } catch (error) {
    console.error("[API] POST /api/v1/auth/logout error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
