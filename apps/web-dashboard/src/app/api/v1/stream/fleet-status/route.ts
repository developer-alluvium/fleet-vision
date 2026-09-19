import { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import Redis from "ioredis";
import { prisma, getLiveMap, getFleetStatusSummary, computeDeviceStatus } from "@fleet-vision/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    const orgId = auth.organizationId;
    if (!orgId) {
      return new Response(JSON.stringify({ error: "Could not determine organization from authentication" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Dedicated Redis client for Pub/Sub subscription
    const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

    let heartbeatInterval: NodeJS.Timeout;

    const stream = new ReadableStream({
      async start(controller) {
        // 1. Send initial snapshot immediately
        const [devices, liveMap, existingSummary] = await Promise.all([
          prisma.device.findMany({ where: { organizationId: orgId }, select: { imei: true } }),
          getLiveMap(orgId),
          getFleetStatusSummary(orgId)
        ]);
        
        let counts = existingSummary.summary;
        let computedAt = existingSummary.computedAt;

        // Fallback: If no summary exists in Redis, calculate it on the fly for the init event
        if (Object.keys(counts).length === 0) {
          const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MINUTES || "5", 10) * 60 * 1000;
          const INACTIVE_THRESHOLD_MS = parseInt(process.env.INACTIVE_THRESHOLD_HOURS || "24", 10) * 60 * 60 * 1000;
          const nowMs = Date.now();

          counts = {
            TOTAL: devices.length,
            RUNNING: 0,
            IDLE: 0,
            STOPPED: 0,
            INACTIVE: 0,
            NO_DATA: 0,
          };

          for (const device of devices) {
            const imei = device.imei;
            const payload = liveMap[imei] as any;
            const status = computeDeviceStatus(payload || null, nowMs, STALE_THRESHOLD_MS, INACTIVE_THRESHOLD_MS);
            counts[status]++;
          }
          computedAt = new Date(nowMs).toISOString();
        }

        controller.enqueue(`event: init\ndata: ${JSON.stringify({ counts, computedAt })}\n\n`);

        // 2. Subscribe to Redis Pub/Sub for ongoing live changes
        const channel = `fleet_status:org:${orgId}`;
        await subscriber.subscribe(channel);

        subscriber.on("message", (ch, message) => {
          if (ch === channel) {
            controller.enqueue(`event: update\ndata: ${message}\n\n`);
          }
        });

        // 3. Keep connection alive through reverse proxies
        heartbeatInterval = setInterval(() => {
          try {
            controller.enqueue(": heartbeat\n\n");
          } catch {
            clearInterval(heartbeatInterval);
          }
        }, 30000);

        // 4. Cleanup on disconnect
        const cleanup = () => {
          clearInterval(heartbeatInterval);
          subscriber.unsubscribe(channel).catch(() => {});
          subscriber.quit().catch(() => {});
        };

        if (request.signal.aborted) {
          cleanup();
        } else {
          request.signal.addEventListener("abort", cleanup);
        }
      },
      cancel() {
        clearInterval(heartbeatInterval);
        subscriber.quit().catch(() => {});
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // Disables Nginx buffering
      },
    });
  } catch (error: any) {
    console.error("[API] GET /api/v1/stream/fleet-status error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: error.message?.includes("Authentication required") || error.message?.includes("Invalid token") ? 401 : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
