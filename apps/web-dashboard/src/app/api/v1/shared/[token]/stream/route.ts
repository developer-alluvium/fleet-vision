import { NextRequest } from "next/server";
import Redis from "ioredis";
import { prisma } from "@fleet-vision/db";
import { resolveShare, SHARE_SECURITY_HEADERS } from "@/lib/shareJourney";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { token } = await params;

    const resolved = await resolveShare(token);
    if (!resolved.success) {
      return new Response(JSON.stringify({ error: resolved.error }), {
        status: resolved.status,
        headers: {
          ...SHARE_SECURITY_HEADERS,
          "Content-Type": "application/json",
        },
      });
    }

    const { imei, share } = resolved;
    const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
    const channel = `journey:device:${imei}`;

    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isCleanedUp = false;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.quit().catch(() => {});
    };

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(": heartbeat\n\n");

        subscriber.subscribe(channel, (err) => {
          if (err) {
            console.error(`[SSE Shared] Failed to subscribe to ${channel}:`, err);
            controller.error(err);
            cleanup();
          }
        });

        subscriber.on("message", (ch, rawMessage) => {
          if (ch !== channel || isCleanedUp) return;

          try {
            const data = JSON.parse(rawMessage);
            // Strict data minimization: no IMEI, no orgId, conditional speed
            const payload = {
              lat: data.latitude,
              lng: data.longitude,
              speed: share.showSpeed ? data.speed : undefined,
              ignition: data.ignition,
              time: data.timestamp,
            };

            controller.enqueue(`event: journey:point\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch (err) {
            // Client may have disconnected or invalid JSON, ignore
          }
        });

        // 30-second heartbeat with active token validation (Gap #5 revocation failsafe)
        heartbeatTimer = setInterval(async () => {
          if (isCleanedUp) return;

          try {
            const current = await prisma.sharedJourney.findUnique({
              where: { tokenHash: share.tokenHash },
              select: { status: true, expiresAt: true },
            });

            const now = Date.now();
            if (
              !current ||
              current.status !== "ACTIVE" ||
              current.expiresAt.getTime() <= now
            ) {
              controller.enqueue(
                `event: share:expired\ndata: ${JSON.stringify({
                  reason: current?.status === "REVOKED" ? "revoked" : "expired",
                })}\n\n`
              );
              cleanup();
              controller.close();
              return;
            }

            controller.enqueue(": heartbeat\n\n");
          } catch (err) {
            // If DB query fails during heartbeat, keep stream alive but don't crash
            try {
              controller.enqueue(": heartbeat\n\n");
            } catch {
              cleanup();
            }
          }
        }, 30000);

        if (request.signal.aborted) {
          cleanup();
        } else {
          request.signal.addEventListener("abort", cleanup);
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        ...SHARE_SECURITY_HEADERS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: any) {
    console.error("[API] GET /api/v1/shared/[token]/stream error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: 500,
        headers: {
          ...SHARE_SECURITY_HEADERS,
          "Content-Type": "application/json",
        },
      }
    );
  }
}
