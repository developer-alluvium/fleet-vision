import { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import Redis from "ioredis";
import { prisma, getLiveMapSafe, computeDeviceStatus, DeviceStatus } from "@fleet-vision/db";
import {
  parseStatusFilter,
  buildDeviceRealtimePayload,
  applyFilterTransition,
  DeviceRealtimePayload,
  VehiclePayload,
} from "@/lib/realtimeDevices";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const REGISTRY_REFRESH_MS = parseInt(process.env.REALTIME_STREAM_REGISTRY_REFRESH_MS || "60000", 10);
const STALE_MS = parseInt(process.env.STALE_THRESHOLD_MINUTES || "5", 10) * 60 * 1000;
const INACTIVE_MS = parseInt(process.env.INACTIVE_THRESHOLD_HOURS || "24", 10) * 60 * 60 * 1000;
const MAX_CONN_PER_ORG = parseInt(process.env.REALTIME_STREAM_MAX_CONN_PER_ORG || "25", 10);
const MIN_UPDATE_INTERVAL_MS = parseInt(process.env.REALTIME_STREAM_MIN_UPDATE_INTERVAL_MS || "1000", 10);

const orgConnections = new Map<string, number>();

export async function GET(request: NextRequest) {
  if (process.env.ENABLE_STREAM_DEVICES === "false") {
    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
  }

  try {
    const auth = await authenticate(request);
    const orgId = auth.organizationId;
    if (!orgId) {
      return new Response(JSON.stringify({ error: "Unauthorized access to this organization" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    let streamParams;
    try {
      streamParams = parseStatusFilter(request.nextUrl.searchParams);
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const currentConns = orgConnections.get(orgId) || 0;
    if (currentConns >= MAX_CONN_PER_ORG) {
      return new Response(JSON.stringify({ error: "Too many concurrent streams for this organization" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    orgConnections.set(orgId, currentConns + 1);

    const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

    const registry = new Map<string, { deviceId: string; deviceStatus: string; vehicle: VehiclePayload | null }>();
    const live = new Map<string, any>();
    const statuses = new Map<string, DeviceStatus>();
    const inFilterSet = new Set<string>();
    let seq = 1;

    let heartbeatInterval: NodeJS.Timeout;
    let refreshInterval: NodeJS.Timeout;

    const stream = new ReadableStream({
      async start(controller) {
        const enqueueEvent = (event: string, data: any) => {
          const id = `${Date.now()}-${seq++}`;
          try {
            controller.enqueue(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            // connection likely closed
          }
        };

        const locationChannel = `location:org:${orgId}`;
        const fleetStatusChannel = `fleet_status:org:${orgId}`;

        // Subscribe to channels immediately
        await subscriber.subscribe(locationChannel, fleetStatusChannel);

        // Fetch snapshot
        const [dbDevices, liveMap] = await Promise.all([
          prisma.device.findMany({
            where: { organizationId: orgId },
            include: { vehicle: true },
          }),
          getLiveMapSafe(orgId),
        ]);

        for (const d of dbDevices) {
          registry.set(d.imei, {
            deviceId: d.id,
            deviceStatus: d.status,
            vehicle: d.vehicle as VehiclePayload | null,
          });
        }

        const nowMs = Date.now();
        const initDevices: DeviceRealtimePayload[] = [];
        const summaryCounts: Record<DeviceStatus, number> = {
          RUNNING: 0,
          IDLE: 0,
          STOPPED: 0,
          INACTIVE: 0,
          NO_DATA: 0,
        };

        for (const [imei, reg] of registry.entries()) {
          const liveData = liveMap[imei] || null;
          live.set(imei, liveData);
          const status = computeDeviceStatus(liveData, nowMs, STALE_MS, INACTIVE_MS);
          statuses.set(imei, status);
          summaryCounts[status]++;

          const matches = streamParams.statusFilter === "all" || streamParams.statusFilter.has(status);
          if (matches) {
            inFilterSet.add(imei);
            const payload = buildDeviceRealtimePayload(imei, reg.deviceId, reg.deviceStatus, status, liveData, reg.vehicle, nowMs, streamParams);
            initDevices.push(payload);
          }
        }

        const summary = {
          total: registry.size,
          matched: inFilterSet.size,
          byStatus: summaryCounts,
        };

        enqueueEvent("init", {
          organizationId: orgId,
          serverTime: new Date(nowMs).toISOString(),
          filter: {
            status: streamParams.statusFilter === "all" ? "all" : Array.from(streamParams.statusFilter),
            includeVehicle: streamParams.includeVehicle,
          },
          thresholds: {
            staleMinutes: STALE_MS / 60000,
            inactiveHours: INACTIVE_MS / 3600000,
          },
          summary,
          devices: initDevices,
        });

        const lastDeviceUpdate = new Map<string, number>();

        subscriber.on("message", (ch, message) => {
          if (ch === locationChannel) {
            try {
              const data = JSON.parse(message);
              const { imei, ...telemetry } = data;
              if (!imei) return;

              const reg = registry.get(imei);
              if (!reg) return;

              const currentLive = live.get(imei) || {};
              const newLive = { ...currentLive, ...telemetry, updatedAt: new Date().toISOString() };
              live.set(imei, newLive);

              const now = Date.now();
              const prevStatus = statuses.get(imei) || "NO_DATA";
              const newStatus = computeDeviceStatus(newLive, now, STALE_MS, INACTIVE_MS);
              statuses.set(imei, newStatus);

              const wasInFilter = inFilterSet.has(imei);
              const nowInFilter = streamParams.statusFilter === "all" || streamParams.statusFilter.has(newStatus);

              const transition = applyFilterTransition(wasInFilter, nowInFilter);
              
              if (nowInFilter) inFilterSet.add(imei);
              else inFilterSet.delete(imei);

              if (transition.type === "UPDATE") {
                // Coalesce updates
                const lastUpd = lastDeviceUpdate.get(imei) || 0;
                if (now - lastUpd < MIN_UPDATE_INTERVAL_MS && prevStatus === newStatus) return;
                lastDeviceUpdate.set(imei, now);
              }

              if (transition.type === "EXIT") {
                enqueueEvent("device:exit", { imei, deviceId: reg.deviceId, status: newStatus, reason: transition.reason });
              } else if (transition.type === "ENTER") {
                const payload = buildDeviceRealtimePayload(imei, reg.deviceId, reg.deviceStatus, newStatus, newLive, reg.vehicle, now, streamParams, prevStatus);
                enqueueEvent("device:enter", payload);
              } else if (transition.type === "UPDATE") {
                const payload = buildDeviceRealtimePayload(imei, reg.deviceId, reg.deviceStatus, newStatus, newLive, reg.vehicle, now, streamParams, prevStatus);
                enqueueEvent("device:update", payload);
              }
            } catch (err) {}
          } else if (ch === fleetStatusChannel) {
            try {
              const data = JSON.parse(message);
              if (data.counts && data.changed) {
                const now = Date.now();
                let filterChanged = false;
                for (const change of data.changed) {
                  const { imei, newStatus } = change;
                  if (!registry.has(imei)) continue;
                  
                  const prevStatus = statuses.get(imei) || "NO_DATA";
                  statuses.set(imei, newStatus);

                  const wasInFilter = inFilterSet.has(imei);
                  const nowInFilter = streamParams.statusFilter === "all" || streamParams.statusFilter.has(newStatus as DeviceStatus);

                  const transition = applyFilterTransition(wasInFilter, nowInFilter);
                  
                  if (nowInFilter) inFilterSet.add(imei);
                  else inFilterSet.delete(imei);

                  const reg = registry.get(imei)!;
                  if (transition.type === "EXIT") {
                    enqueueEvent("device:exit", { imei, deviceId: reg.deviceId, status: newStatus, reason: transition.reason });
                    filterChanged = true;
                  } else if (transition.type === "ENTER") {
                    const payload = buildDeviceRealtimePayload(imei, reg.deviceId, reg.deviceStatus, newStatus as DeviceStatus, live.get(imei), reg.vehicle, now, streamParams, prevStatus);
                    enqueueEvent("device:enter", payload);
                    filterChanged = true;
                  } else if (transition.type === "UPDATE") {
                    const payload = buildDeviceRealtimePayload(imei, reg.deviceId, reg.deviceStatus, newStatus as DeviceStatus, live.get(imei), reg.vehicle, now, streamParams, prevStatus);
                    enqueueEvent("device:update", payload);
                  }
                }
                
                // Always send summary if changed is not empty
                if (data.changed.length > 0) {
                  enqueueEvent("summary", {
                    total: registry.size,
                    matched: inFilterSet.size,
                    byStatus: data.counts,
                    computedAt: data.computedAt || new Date().toISOString()
                  });
                }
              }
            } catch (err) {}
          }
        });

        heartbeatInterval = setInterval(() => {
          try {
            controller.enqueue(": heartbeat\n\n");
          } catch (e) {
            clearInterval(heartbeatInterval);
          }
        }, HEARTBEAT_MS);

        refreshInterval = setInterval(async () => {
          try {
            const dbDevices = await prisma.device.findMany({
              where: { organizationId: orgId },
              include: { vehicle: true },
            });
            const changedImeis: string[] = [];
            const newRegistry = new Map<string, { deviceId: string; deviceStatus: string; vehicle: VehiclePayload | null }>();
            
            for (const d of dbDevices) {
              newRegistry.set(d.imei, {
                deviceId: d.id,
                deviceStatus: d.status,
                vehicle: d.vehicle as VehiclePayload | null,
              });
              const oldReg = registry.get(d.imei);
              if (!oldReg || oldReg.vehicle?.id !== d.vehicle?.id) {
                changedImeis.push(d.imei);
                registry.set(d.imei, newRegistry.get(d.imei)!);
              }
            }

            if (changedImeis.length > 0) {
              const now = Date.now();
              const devices = [];
              for (const imei of changedImeis) {
                const wasInFilter = inFilterSet.has(imei);
                if (wasInFilter) {
                   const reg = registry.get(imei)!;
                   const payload = buildDeviceRealtimePayload(imei, reg.deviceId, reg.deviceStatus, statuses.get(imei) || "NO_DATA", live.get(imei), reg.vehicle, now, streamParams);
                   devices.push(payload);
                }
              }
              if (devices.length > 0) {
                enqueueEvent("registry:refresh", { changedImeis, change: "VEHICLE_ASSIGNMENT", devices });
              }
            }
          } catch (err) {
            enqueueEvent("error", { message: "Registry refresh failed", recoverable: true });
          }
        }, REGISTRY_REFRESH_MS);

        const cleanup = () => {
          clearInterval(heartbeatInterval);
          clearInterval(refreshInterval);
          subscriber.unsubscribe(locationChannel, fleetStatusChannel).catch(() => {});
          subscriber.quit().catch(() => {});
          
          const current = orgConnections.get(orgId) || 0;
          if (current > 0) {
            orgConnections.set(orgId, current - 1);
          }
        };

        if (request.signal.aborted) {
          cleanup();
        } else {
          request.signal.addEventListener("abort", cleanup);
        }
      },
      cancel() {
        const current = orgConnections.get(orgId) || 0;
        if (current > 0) {
          orgConnections.set(orgId, current - 1);
        }
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
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: error.message?.includes("Authentication required") || error.message?.includes("Invalid token") ? 401 : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
