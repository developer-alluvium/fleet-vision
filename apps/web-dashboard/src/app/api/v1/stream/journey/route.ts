import { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import Redis from "ioredis";
import { prisma } from "@fleet-vision/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate
    const auth = await authenticate(request);

    // 2. Validate params
    const orgId = request.nextUrl.searchParams.get("orgId");
    const imei = request.nextUrl.searchParams.get("imei");
    const since = request.nextUrl.searchParams.get("since");

    if (!orgId || !imei) {
      return new Response(JSON.stringify({ error: "orgId and imei query parameters are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (auth.organizationId !== orgId) {
      return new Response(JSON.stringify({ error: "Forbidden: You can only access your own organization's stream" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sinceDate: Date | null = null;
    if (since) {
      const parsed = new Date(since);
      if (!isNaN(parsed.getTime())) {
        sinceDate = parsed;
      } else {
        return new Response(JSON.stringify({ error: "Invalid since ISO date format" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 3. Verify device belongs to this organization
    const device = await prisma.device.findUnique({
      where: { imei },
    });
    if (!device || device.organizationId !== orgId) {
      return new Response(JSON.stringify({ error: "Device not found in this organization" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Create dedicated Redis subscriber
    const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

    // 5. Create SSE Stream
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(": heartbeat\n\n");

        // If 'since' date parameter was provided, fetch and stream historical points first
        if (sinceDate) {
          try {
            const records = await prisma.telemetryRecord.findMany({
              where: {
                imei,
                organizationId: orgId,
                time: {
                  gte: sinceDate,
                },
              },
              orderBy: { time: "asc" },
              take: 10000,
              select: {
                time: true,
                latitude: true,
                longitude: true,
                speed: true,
                ignition: true,
              },
            });

            const history = records.map((r) => ({
              lat: r.latitude,
              lng: r.longitude,
              speed: r.speed,
              ignition: r.ignition,
              time: r.time,
            }));

            controller.enqueue(`event: journey:history\ndata: ${JSON.stringify(history)}\n\n`);
          } catch (historyErr) {
            console.error("[SSE Journey] Error fetching historical points:", historyErr);
          }
        }

        const channel = `location:device:${imei}`;
        subscriber.subscribe(channel, (err) => {
          if (err) {
            console.error("[SSE Journey] Failed to subscribe:", err);
            controller.error(err);
          }
        });

        subscriber.on("message", (ch, message) => {
          if (ch === channel) {
            controller.enqueue(`event: journey:point\ndata: ${message}\n\n`);
          }
        });

        const heartbeat = setInterval(() => {
          controller.enqueue(": heartbeat\n\n");
        }, 30000);

        request.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          subscriber.unsubscribe(channel);
          subscriber.quit();
        });
      },
      cancel() {
        subscriber.quit();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: any) {
    console.error("[API] GET /api/v1/stream/journey error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: error.message?.includes("Authentication required") || error.message?.includes("Invalid token") ? 401 : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
