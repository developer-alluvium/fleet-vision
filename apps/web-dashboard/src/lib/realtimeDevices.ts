import type { DeviceStatus } from "@fleet-vision/db";

export type StatusFilter = Set<DeviceStatus> | "all";

export interface StreamParams {
  statusFilter: StatusFilter;
  includeVehicle: boolean;
  fieldWhitelist: Set<string> | null;
}

export interface VehiclePayload {
  id: string;
  plateNumber: string;
  make: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  vin: string | null;
  vehicleType: string | null;
  fuelType: string | null;
  maxFuelCapacity: number | null;
  status: string;
}

export interface DeviceRealtimePayload {
  imei: string;
  deviceId: string;
  deviceStatus: string;
  status: DeviceStatus;
  previousStatus?: DeviceStatus;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;
  angle: number | null;
  ignition: boolean | null;
  fuelLevelRaw: number | null;
  fuelLevelLiters: number | null;
  odometer: number | null;
  timestamp: string | null;
  updatedAt: string | null;
  lastSeenAgeSec: number | null;
  vehicle: VehiclePayload | null;
  [key: string]: any;
}

export function parseStatusFilter(params: URLSearchParams): StreamParams {
  const statusRaw = params.get("status")?.trim() || "all";
  const includeVehicleRaw = params.get("includeVehicle");
  const fieldsRaw = params.get("fields");

  const includeVehicle = includeVehicleRaw ? includeVehicleRaw.toLowerCase() !== "false" : true;
  const fieldWhitelist = fieldsRaw ? new Set(fieldsRaw.split(",").map(f => f.trim())) : null;

  if (statusRaw.toLowerCase() === "all") {
    return { statusFilter: "all", includeVehicle, fieldWhitelist };
  }

  const validStatuses = new Set<DeviceStatus>(["RUNNING", "IDLE", "STOPPED", "INACTIVE", "NO_DATA"]);
  const filterTokens = statusRaw.split(",").map((s) => s.trim().toUpperCase());
  
  if (filterTokens.includes("ALL")) {
    throw new Error("'all' cannot be combined with other status filters");
  }

  const statusFilter = new Set<DeviceStatus>();
  for (const token of filterTokens) {
    if (!validStatuses.has(token as DeviceStatus)) {
      throw new Error(`Invalid status filter: '${token}'. Allowed: all, running, idle, stopped, inactive, no_data`);
    }
    statusFilter.add(token as DeviceStatus);
  }

  return { statusFilter, includeVehicle, fieldWhitelist };
}

export function buildDeviceRealtimePayload(
  imei: string,
  deviceId: string,
  deviceStatus: string,
  status: DeviceStatus,
  liveData: any,
  vehicle: VehiclePayload | null,
  nowMs: number,
  params: StreamParams,
  previousStatus?: DeviceStatus
): DeviceRealtimePayload {
  let lastSeenAgeSec: number | null = null;
  if (liveData?.timestamp) {
    lastSeenAgeSec = Math.max(0, Math.floor((nowMs - new Date(liveData.timestamp).getTime()) / 1000));
  }

  const payload: DeviceRealtimePayload = {
    imei,
    deviceId,
    deviceStatus,
    status,
    latitude: liveData?.latitude ?? null,
    longitude: liveData?.longitude ?? null,
    speed: liveData?.speed ?? null,
    angle: liveData?.angle ?? null,
    ignition: liveData?.ignition ?? null,
    fuelLevelRaw: liveData?.fuelLevelRaw ?? null,
    fuelLevelLiters: liveData?.fuelLevelLiters ?? null,
    odometer: liveData?.odometer ?? null,
    timestamp: liveData?.timestamp ?? null,
    updatedAt: liveData?.updatedAt ?? liveData?.timestamp ?? null,
    lastSeenAgeSec,
    vehicle: params.includeVehicle ? vehicle : null,
  };

  if (previousStatus && previousStatus !== status) {
    payload.previousStatus = previousStatus;
  }

  if (params.fieldWhitelist) {
    const shaped: any = {};
    for (const key of params.fieldWhitelist) {
      if (key in payload) {
        shaped[key] = (payload as any)[key];
      }
    }
    return shaped as DeviceRealtimePayload;
  }

  return payload;
}

export type TransitionResult =
  | { type: "NONE" }
  | { type: "UPDATE" }
  | { type: "ENTER" }
  | { type: "EXIT"; reason: "FILTER_EXIT" };

export function applyFilterTransition(
  wasInFilter: boolean,
  nowInFilter: boolean
): TransitionResult {
  if (wasInFilter && nowInFilter) return { type: "UPDATE" };
  if (wasInFilter && !nowInFilter) return { type: "EXIT", reason: "FILTER_EXIT" };
  if (!wasInFilter && nowInFilter) return { type: "ENTER" };
  return { type: "NONE" };
}
