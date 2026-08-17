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
    let orgId = request.nextUrl.searchParams.get("orgId");
    const imei = request.nextUrl.searchParams.get("imei");
    const since = request.nextUrl.searchParams.get("since");

    if (orgId && auth.organizationId !== orgId) {
      return new Response(JSON.stringify({ error: "Forbidden: You can only access your own organization's stream" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Use orgId from auth if not provided
    orgId = orgId || auth.organizationId;

    if (!orgId || !imei) {
      return new Response(JSON.stringify({ error: "imei query parameter is required (and orgId if no auth context)" }), {
        status: 400,
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
    // Strategy: Subscribe FIRST, buffer messages, query history, then flush.
    // This eliminates the race condition where records arriving between
    // the DB query and subscription start would be silently lost.
    let heartbeat: NodeJS.Timeout;
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(": heartbeat\n\n");

        // ── Step 1: Subscribe to journey channel FIRST ──
        // Buffer messages that arrive while we query historical data
        const messageBuffer: string[] = [];
        let isBuffering = true;

        const formatRedisMessage = (rawMessage: string) => {
          try {
            const data = JSON.parse(rawMessage);
            return JSON.stringify({
              lat: data.latitude,
              lng: data.longitude,
              speed: data.speed,
              ignition: data.ignition,
              time: data.timestamp,
              serverCreatedAt: data.publishedAt,
            });
          } catch (e) {
            return rawMessage;
          }
        };

        const channel = `journey:device:${imei}`;
        subscriber.subscribe(channel, (err) => {
          if (err) {
            console.error("[SSE Journey] Failed to subscribe:", err);
            controller.error(err);
          }
        });

        subscriber.on("message", (ch, message) => {
          if (ch === channel) {
            const formattedMessage = formatRedisMessage(message);
            if (isBuffering) {
              // Buffer messages while historical query is in progress
              messageBuffer.push(formattedMessage);
            } else {
              try {
                controller.enqueue(`event: journey:point\ndata: ${formattedMessage}\n\n`);
              } catch (err) {
                // Client disconnected, ignore
              }
            }
          }
        });

        // ── Step 2: Query historical data from DB ──
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
                serverCreatedAt: true,
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
              serverCreatedAt: r.serverCreatedAt,
            }));

            // ── Step 3: Emit history ──
            try {
              controller.enqueue(`event: journey:history\ndata: ${JSON.stringify(history)}\n\n`);
            } catch (err) {
              // Client disconnected, ignore
            }
          } catch (historyErr) {
            console.error("[SSE Journey] Error fetching historical points:", historyErr);
          }
        }

        // ── Step 4: Flush buffered messages that arrived during DB query ──
        isBuffering = false;
        for (const buffered of messageBuffer) {
          try {
            controller.enqueue(`event: journey:point\ndata: ${buffered}\n\n`);
          } catch (err) {
            // Client disconnected, ignore
          }
        }
        messageBuffer.length = 0; // Clear buffer

        // ── Step 5: Continue streaming live (handled by subscriber.on above) ──

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(": heartbeat\n\n");
          } catch (err) {
            clearInterval(heartbeat);
          }
        }, 30000);

        const cleanup = () => {
          clearInterval(heartbeat);
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
        clearInterval(heartbeat);
        subscriber.quit().catch(() => {});
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
