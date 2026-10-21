import { PrismaClient } from "@prisma/client";

// Re-export all Prisma generated types for consumer packages
export * from "@prisma/client";

// Re-export Redis client and helpers
export {
  redis,
  authorizeDevice,
  revokeDevice,
  getDeviceAuth,
  updateLiveMap,
  getLiveMap,
  getLiveMapSafe,
  getLiveLocationsByImeis,
  publishLocationUpdate,
  publishJourneyRecords,
  cacheVehicleFuelSettings,
  getCachedFuelSettings,
  invalidateFuelSettingsCache,
  cacheCalibrationTable,
  getCachedCalibrationTable,
  invalidateCalibrationCache,
  // Fleet Status Helpers
  computeDeviceStatus,
  updateFleetStatus,
  getFleetStatusSummary,
  getFleetStatusDetails,
  publishFleetStatusUpdate,
  getFleetDashboardPayload,
  // Geofence Helpers
  cacheOrgGeofences,
  getCachedOrgGeofences,
  invalidateGeofenceCache,
  getDeviceGeofenceState,
  updateDeviceGeofenceState,
  publishGeofenceAlert,
  // Geofence Speed Episode State
  getGeofenceSpeedEpisodeState,
  setGeofenceSpeedEpisodeState,
  deleteGeofenceSpeedEpisodeState,
  // Speed Helpers
  getDeviceSpeedState,
  checkAndSetSpeedState,
  publishSpeedAlert,
} from "./redis";

export type { FleetDashboardPayload, DeviceStatus, GeofenceCacheEntry, GeofenceTransition, GeofenceAlertPayload, SpeedAlertPayload } from "./redis";

export * from "./fuelCalibration";


// Global singleton to prevent multiple PrismaClient instances in development
// (hot-reload creates new modules but we want to reuse the DB connection pool)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  timescalePrisma: PrismaClient | undefined;
};

// Clear cached instance if schema changed in development
if (process.env.NODE_ENV !== "production") {
  delete globalForPrisma.prisma;
  delete globalForPrisma.timescalePrisma;
}

// Primary database client (RDS in production, local container in development)
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "info", "warn", "error"]
        : ["error"],
  });

// Dedicated TimescaleDB client for time-series telemetry records
// In production: points to TIMESCALE_URL (e.g. self-hosted TimescaleDB on EC2)
// In development: falls back to primary `prisma` client if TIMESCALE_URL is not provided or equals DATABASE_URL
const timescaleUrl = process.env.TIMESCALE_URL;

export const timescalePrisma: PrismaClient =
  timescaleUrl && timescaleUrl !== process.env.DATABASE_URL
    ? (globalForPrisma.timescalePrisma ??= new PrismaClient({
        datasources: {
          db: {
            url: timescaleUrl,
          },
        },
        log:
          process.env.NODE_ENV === "development"
            ? ["query", "info", "warn", "error"]
            : ["error"],
      }))
    : prisma;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.timescalePrisma = timescalePrisma;
}

