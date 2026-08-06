import { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import Redis from "ioredis";
import { prisma, getLiveMap } from "@fleet-vision/db";

// SSE endpoints can take a long time, but Next.js app router handles streams fine.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate using headers or query parameters (supported by updated auth.ts)
    const auth = await authenticate(request);

    // 2. Derive orgId directly from the authentication context
    const orgId = auth.organizationId;
    if (!orgId) {
      return new Response(JSON.stringify({ error: "Could not determine organization from authentication" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Fetch initial snapshot data
    const [devices, liveMap] = await Promise.all([
      prisma.device.findMany({
        where: { organizationId: orgId },
        include: { vehicle: true },
      }),
      getLiveMap(orgId)
    ]);

    const devicesWithLocation = devices.map(device => ({
      ...device,
      location: liveMap[device.imei] || null
    }));

    // 5. Create a dedicated Redis subscriber
    // We cannot reuse the main Redis connection for Pub/Sub because a connection in subscriber mode
    // cannot issue standard Redis commands.
    const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

    // 6. Create a readable stream for SSE
    const stream = new ReadableStream({
      start(controller) {
        // Send initial heartbeat to establish connection
        controller.enqueue(": heartbeat\n\n");

        // Send the initial snapshot
        controller.enqueue(`event: init\ndata: ${JSON.stringify(devicesWithLocation)}\n\n`);

        // Subscribe to org channel
        const channel = `location:org:${orgId}`;
        subscriber.subscribe(channel, (err) => {
          if (err) {
            console.error("[SSE Fleet] Failed to subscribe:", err);
            controller.error(err);
          }
        });

        subscriber.on("message", (ch, message) => {
          if (ch === channel) {
            controller.enqueue(`event: location:update\ndata: ${message}\n\n`);
          }
        });

        // Heartbeat every 30s to keep connection alive through proxies/load balancers
        const heartbeat = setInterval(() => {
          controller.enqueue(": heartbeat\n\n");
        }, 30000);

        // Cleanup when client disconnects
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

    // 6. Return SSE response
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        // Disable nginx/proxy buffering for real-time streaming
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: any) {
    console.error("[API] GET /api/v1/stream/fleet error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: error.message?.includes("Authentication required") || error.message?.includes("Invalid token") ? 401 : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
