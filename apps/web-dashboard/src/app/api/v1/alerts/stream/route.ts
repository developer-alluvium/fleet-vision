import { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import Redis from "ioredis";

// We create a new redis instance per connection for the subscriber
// Do not use the global one since pub/sub blocks other commands on the connection
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * Generic alert stream endpoint.
 * 
 * Currently subscribes to:
 *   - geofence_alerts:org:{orgId}  → geofence:enter, geofence:exit, geofence:speed
 * 
 * To add new alert types in the future:
 *   1. Subscribe to the new Redis channel below
 *   2. Add a handler in the `subscriber.on("message", ...)` block
 *   3. Each alert category should use a distinct SSE event name prefix (e.g., "maintenance:due")
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    let isClientConnected = true;
    const subscriber = new Redis(REDIS_URL);

    // ── Channels to subscribe ────────────────────────────────
    // Add new alert channels here as you introduce more alert types
    const channels = [
      `geofence_alerts:org:${auth.organizationId}`,
      // `maintenance_alerts:org:${auth.organizationId}`,
      // `sos_alerts:org:${auth.organizationId}`,
      // `tampering_alerts:org:${auth.organizationId}`,
    ];

    let heartbeat: NodeJS.Timeout;

    const cleanup = () => {
      if (!isClientConnected) return;
      isClientConnected = false;
      if (heartbeat) clearInterval(heartbeat);
      
      subscriber.unsubscribe(...channels)
        .catch(() => {})
        .finally(() => {
          subscriber.quit().catch(() => {});
        });
      console.log(`[SSE] Alert stream client disconnected for org ${auth.organizationId}`);
    };

    const stream = new ReadableStream({
      start(controller) {
        // Send initial heartbeat
        controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));

        subscriber.subscribe(...channels, (err) => {
          if (err) {
            console.error(`[SSE] Failed to subscribe to alert channels:`, err);
            controller.error(err);
            return;
          }
          console.log(`[SSE] Alert stream subscribed to ${channels.length} channel(s) for org ${auth.organizationId}`);
        });

        subscriber.on("message", (ch, message) => {
          if (!isClientConnected) return;

          try {
            const parsed = JSON.parse(message);

            // ── Route by channel ─────────────────────────────
            // Each channel maps to a category + specific event names

            if (ch === `geofence_alerts:org:${auth.organizationId}`) {
              // Geofence alerts → geofence:enter, geofence:exit, geofence:speed
              let eventType = "geofence:alert";
              if (parsed.eventType === "ENTER") eventType = "geofence:enter";
              else if (parsed.eventType === "EXIT") eventType = "geofence:exit";
              else if (parsed.eventType === "SPEED_VIOLATION") eventType = "geofence:speed";

              const payload = {
                category: "GEOFENCE",
                ...parsed,
              };

              const ssePayload = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
              controller.enqueue(new TextEncoder().encode(ssePayload));
            }

            // ── Future alert categories ──────────────────────
            // else if (ch === `maintenance_alerts:org:${auth.organizationId}`) {
            //   const payload = { category: "maintenance", ...parsed };
            //   const ssePayload = `event: maintenance:${parsed.eventType?.toLowerCase() || "alert"}\ndata: ${JSON.stringify(payload)}\n\n`;
            //   controller.enqueue(new TextEncoder().encode(ssePayload));
            // }

          } catch (err) {
            if (err instanceof Error && err.message.includes("closed")) {
              cleanup();
            } else {
              console.error("[SSE] Error processing alert message:", err);
            }
          }
        });

        // Heartbeat to keep connection alive
        heartbeat = setInterval(() => {
          if (isClientConnected) {
            try {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
            } catch (err) {
              cleanup();
            }
          }
        }, 30000);

        // Cleanup on connection close
        request.signal.addEventListener("abort", cleanup);
      },
      cancel() {
        cleanup();
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
    console.error(`[API] GET /api/v1/alerts/stream error:`, error);
    if (error.message && (error.message.includes("Authentication required") || error.message.includes("Invalid token") || error.message.includes("API key"))) {
      return new Response(JSON.stringify({ error: error.message }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
