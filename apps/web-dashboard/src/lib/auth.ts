import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { prisma } from "@fleet-vision/db";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "default_super_secret_key_change_me_in_prod"
);

export async function authenticate(request: NextRequest) {
  // 1. Check for API Key in headers or query params
  const apiKey = request.headers.get("x-api-key") || request.nextUrl.searchParams.get("apiKey");
  if (apiKey) {
    const org = await prisma.organization.findUnique({
      where: { apiKey },
    });
    if (org && org.status === "ACTIVE") {
      return { organizationId: org.id, type: "api-key" };
    }
    throw new Error("Invalid or inactive API key");
  }

  // 2. Check for JWT Token in cookies, headers, or query params
  let token = request.cookies.get("accessToken")?.value || "";
  
  if (!token) {
    const authHeader = request.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else {
      const queryToken = request.nextUrl.searchParams.get("token");
      if (queryToken && queryToken.startsWith("Bearer ")) {
        token = queryToken.substring(7);
      }
    }
  }

  if (token) {
    try {
      const { payload } = await jwtVerify(token, JWT_SECRET);
      if (payload && payload.organizationId) {
        return {
          userId: payload.userId as string,
          organizationId: payload.organizationId as string,
          role: payload.role as string,
          type: "jwt",
        };
      }
    } catch (err) {
      throw new Error("Invalid token");
    }
  }

  throw new Error("Authentication required: provide a valid JWT or x-api-key");
}
