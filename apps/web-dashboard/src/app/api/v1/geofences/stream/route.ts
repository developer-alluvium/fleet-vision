import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import Redis from "ioredis";

// We create a new redis instance per connection for the subscriber
// Do not use the global one since pub/sub blocks other commands on the connection
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);

    let isClientConnected = true;
    const subscriber = new Redis(REDIS_URL);
    const channel = `geofence_alerts:org:${auth.organizationId}`;

    const stream = new ReadableStream({
      start(controller) {
        // Send initial heartbeat
        controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));

        subscriber.subscribe(channel, (err) => {
          if (err) {
            console.error(`[SSE] Failed to subscribe to ${channel}:`, err);
            controller.error(err);
            return;
          }
          console.log(`[SSE] Subscribed to ${channel}`);
        });

        subscriber.on("message", (ch, message) => {
          if (ch === channel && isClientConnected) {
            try {
              const parsed = JSON.parse(message);
              let eventType = "alert";
              
              if (parsed.eventType === "ENTER") eventType = "geofence:enter";
              else if (parsed.eventType === "EXIT") eventType = "geofence:exit";
              else if (parsed.eventType === "SPEED_VIOLATION") eventType = "geofence:speed";

              const payload = `event: ${eventType}\ndata: ${message}\n\n`;
              controller.enqueue(new TextEncoder().encode(payload));
            } catch (err) {
              console.error("[SSE] Error processing geofence alert message:", err);
            }
          }
        });

        // Heartbeat to keep connection alive
        const heartbeat = setInterval(() => {
          if (isClientConnected) {
            try {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
            } catch (err) {
              clearInterval(heartbeat);
            }
          } else {
            clearInterval(heartbeat);
          }
        }, 30000);

        // Cleanup on connection close
        request.signal.addEventListener("abort", () => {
          isClientConnected = false;
          clearInterval(heartbeat);
          subscriber.unsubscribe(channel).then(() => {
            subscriber.quit();
          });
          console.log(`[SSE] Client disconnected from ${channel}`);
        });
      },
      cancel() {
        isClientConnected = false;
        subscriber.unsubscribe(channel).then(() => {
          subscriber.quit();
        });
      }
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  } catch (error: any) {
    console.error(`[API] GET /api/v1/geofences/stream error:`, error);
    if (error.message && (error.message.includes("Authentication required") || error.message.includes("Invalid token") || error.message.includes("API key"))) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
