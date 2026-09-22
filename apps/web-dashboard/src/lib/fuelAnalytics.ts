import { getDistance, Point } from './douglasPeucker';

export interface FuelTelemetryRow {
  time: Date;
  lat: number;
  lng: number;
  speed: number;
  ignition: boolean;
  fuelLevelRaw: number | null;
  fuelLevelLiters: number | null;
  odometer: number | null;
}

export interface FuelTimeBucket {
  bucket: string;
  avgFuelLiters: number;
  minFuelLiters: number;
  maxFuelLiters: number;
  fuelConsumedLiters: number;
  distanceKm: number;
  efficiencyKmPerL: number;
  telemetryPoints: number;
}

export interface DetectedFuelEvent {
  eventType: 'REFUEL' | 'DRAIN' | 'THEFT_SUSPECTED';
  startTime: string;
  endTime: string;
  fuelBefore: number;
  fuelAfter: number;
  deltaLiters: number;
  latitude: number | null;
  longitude: number | null;
  ignitionDuring: boolean;
}

export interface VehicleFuelSummary {
  fuelConsumedLiters: number | null;
  fuelEfficiencyKmPerL: number | null;
  fuelEfficiencyL100Km: number | null;
  totalDistanceKm: number;
  fuelStartLiters: number | null;
  fuelEndLiters: number | null;
  currentFuelPercent: number | null;
  avgFuelLevelLiters: number | null;
  minFuelLevelLiters: number | null;
  maxFuelLevelLiters: number | null;
  avgDailyConsumptionLiters: number | null;
  estimatedRangeKm: number | null;
  refuelEvents: number;
  drainEvents: number;
  theftSuspectedEvents: number;
  telemetryPoints: number;
}

export interface VehicleFuelResult {
  vehicleId: string;
  plateNumber: string;
  imei: string;
  make: string | null;
  model: string | null;
  fuelType: string | null;
  maxFuelCapacity: number | null;
  summary: VehicleFuelSummary;
  fuelTimeSeries: FuelTimeBucket[];
  events: DetectedFuelEvent[];
}

export interface FuelDistribution {
  critical_0_20: number;
  low_20_40: number;
  medium_40_60: number;
  good_60_80: number;
  full_80_100: number;
}

export interface FleetFuelSummary {
  totalVehicles: number;
  vehiclesWithFuelData: number;
  vehiclesWithoutFuelData: number;
  totalFuelConsumedLiters: number;
  avgFuelConsumedPerVehicleLiters: number;
  fleetFuelEfficiencyKmPerL: number;
  fleetFuelEfficiencyL100Km: number;
  totalDistanceKm: number;
  fleetAvgCurrentFuelLiters: number;
  fleetAvgCurrentFuelPercent: number;
  lowFuelVehicleCount: number;
  criticalFuelVehicleCount: number;
  totalRefuelEvents: number;
  totalDrainEvents: number;
  totalTheftSuspectedEvents: number;
  fuelDistribution: FuelDistribution;
}

export type GroupBy = 'hour' | 'day' | 'week';

const REFUEL_THRESHOLD = 5.0; // Liters
const DRAIN_THRESHOLD = 5.0; // Liters
const MAX_GAP_MS = 4 * 60 * 60 * 1000; // 4 hours
const LOW_FUEL_PERCENTAGE = 20;
const CRITICAL_FUEL_PERCENTAGE = 10;

function getBucketKey(time: Date, groupBy: GroupBy): string {
  const d = new Date(time);
  switch (groupBy) {
    case 'hour':
      d.setMinutes(0, 0, 0);
      return d.toISOString();
    case 'day':
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    case 'week': {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      d.setDate(diff);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
  }
}

function createEmptyBucket(bucketKey: string): FuelTimeBucket {
  return {
    bucket: bucketKey,
    avgFuelLiters: 0,
    minFuelLiters: Infinity,
    maxFuelLiters: -Infinity,
    fuelConsumedLiters: 0,
    distanceKm: 0,
    efficiencyKmPerL: 0,
    telemetryPoints: 0,
  };
}

export function computeVehicleFuelAnalytics(
  records: FuelTelemetryRow[],
  groupBy: GroupBy,
  periodStartMs: number,
  periodEndMs: number,
  maxFuelCapacity: number | null
): { summary: VehicleFuelSummary; fuelTimeSeries: FuelTimeBucket[]; events: DetectedFuelEvent[] } {
  const totalPeriodDays = Math.max(1, (periodEndMs - periodStartMs) / (24 * 60 * 60 * 1000));
  
  if (records.length === 0) {
    return {
      summary: emptySummary(),
      fuelTimeSeries: [],
      events: [],
    };
  }

  const buckets = new Map<string, FuelTimeBucket>();
  const bucketFuelSum = new Map<string, number>();
  const bucketFuelCount = new Map<string, number>();

  let totalDistanceM = 0;
  let fuelLevelSum = 0;
  let fuelLevelCount = 0;
  let minFuel = Infinity;
  let maxFuel = -Infinity;
  let totalFuelConsumedLiters = 0;

  const events: DetectedFuelEvent[] = [];
  
  const firstBucketKey = getBucketKey(records[0].time, groupBy);
  buckets.set(firstBucketKey, createEmptyBucket(firstBucketKey));
  bucketFuelSum.set(firstBucketKey, 0);
  bucketFuelCount.set(firstBucketKey, 0);

  let prevRecord = records[0];
  let firstValidFuelRecord = records[0].fuelLevelLiters !== null ? records[0] : null;
  let lastValidFuelRecord = records[0].fuelLevelLiters !== null ? records[0] : null;

  for (let i = 1; i < records.length; i++) {
    const curr = records[i];
    const bucketKey = getBucketKey(curr.time, groupBy);

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, createEmptyBucket(bucketKey));
      bucketFuelSum.set(bucketKey, 0);
      bucketFuelCount.set(bucketKey, 0);
    }

    const bucket = buckets.get(bucketKey)!;
    bucket.telemetryPoints++;

    // Distance
    const prevPoint: Point = { lat: prevRecord.lat, lng: prevRecord.lng };
    const currPoint: Point = { lat: curr.lat, lng: curr.lng };
    const distM = getDistance(prevPoint, currPoint);
    totalDistanceM += distM;
    bucket.distanceKm += distM / 1000;

    // Fuel logic
    if (curr.fuelLevelLiters !== null) {
      if (!firstValidFuelRecord) firstValidFuelRecord = curr;
      lastValidFuelRecord = curr;
      
      fuelLevelSum += curr.fuelLevelLiters;
      fuelLevelCount++;

      if (curr.fuelLevelLiters < minFuel) minFuel = curr.fuelLevelLiters;
      if (curr.fuelLevelLiters > maxFuel) maxFuel = curr.fuelLevelLiters;

      const bfs = bucketFuelSum.get(bucketKey)! + curr.fuelLevelLiters;
      const bfc = bucketFuelCount.get(bucketKey)! + 1;
      bucketFuelSum.set(bucketKey, bfs);
      bucketFuelCount.set(bucketKey, bfc);

      if (curr.fuelLevelLiters < bucket.minFuelLiters) bucket.minFuelLiters = curr.fuelLevelLiters;
      if (curr.fuelLevelLiters > bucket.maxFuelLiters) bucket.maxFuelLiters = curr.fuelLevelLiters;

      // Event Detection
      if (prevRecord.fuelLevelLiters !== null) {
        const deltaFuel = curr.fuelLevelLiters - prevRecord.fuelLevelLiters;
        const deltaTimeMs = curr.time.getTime() - prevRecord.time.getTime();

        if (deltaTimeMs > 0 && deltaTimeMs < MAX_GAP_MS) {
          if (deltaFuel > REFUEL_THRESHOLD) {
            // Refuel Event
            events.push({
              eventType: 'REFUEL',
              startTime: prevRecord.time.toISOString(),
              endTime: curr.time.toISOString(),
              fuelBefore: Number(prevRecord.fuelLevelLiters.toFixed(2)),
              fuelAfter: Number(curr.fuelLevelLiters.toFixed(2)),
              deltaLiters: Number(deltaFuel.toFixed(2)),
              latitude: curr.lat,
              longitude: curr.lng,
              ignitionDuring: curr.ignition || prevRecord.ignition,
            });
          } else if (deltaFuel < -DRAIN_THRESHOLD) {
            // Drain or Theft
            const ignitionDuring = curr.ignition || prevRecord.ignition;
            events.push({
              eventType: ignitionDuring ? 'DRAIN' : 'THEFT_SUSPECTED',
              startTime: prevRecord.time.toISOString(),
              endTime: curr.time.toISOString(),
              fuelBefore: Number(prevRecord.fuelLevelLiters.toFixed(2)),
              fuelAfter: Number(curr.fuelLevelLiters.toFixed(2)),
              deltaLiters: Number(deltaFuel.toFixed(2)),
              latitude: curr.lat,
              longitude: curr.lng,
              ignitionDuring,
            });
          }
        }
      }
    }

    prevRecord = curr;
  }

  const hasFuelData = fuelLevelCount > 0;
  let fuelStart = null;
  let fuelEnd = null;

  if (hasFuelData && firstValidFuelRecord && lastValidFuelRecord) {
    fuelStart = firstValidFuelRecord.fuelLevelLiters;
    fuelEnd = lastValidFuelRecord.fuelLevelLiters;

    const totalRefuelAdded = events
      .filter(e => e.eventType === 'REFUEL')
      .reduce((sum, e) => sum + e.deltaLiters, 0);

    // Net consumption = Start - End + RefuelAdded
    totalFuelConsumedLiters = Math.max(0, (fuelStart ?? 0) - (fuelEnd ?? 0) + totalRefuelAdded);
  }

  const fuelTimeSeries: FuelTimeBucket[] = [];
  for (const [key, bucket] of buckets) {
    const bfc = bucketFuelCount.get(key)!;
    bucket.avgFuelLiters = bfc > 0 ? Number((bucketFuelSum.get(key)! / bfc).toFixed(2)) : 0;
    if (bucket.minFuelLiters === Infinity) bucket.minFuelLiters = 0;
    if (bucket.maxFuelLiters === -Infinity) bucket.maxFuelLiters = 0;
    
    bucket.distanceKm = Number(bucket.distanceKm.toFixed(2));
    bucket.minFuelLiters = Number(bucket.minFuelLiters.toFixed(2));
    bucket.maxFuelLiters = Number(bucket.maxFuelLiters.toFixed(2));
    bucket.efficiencyKmPerL = 0;
    
    fuelTimeSeries.push(bucket);
  }
  fuelTimeSeries.sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime());

  const totalDistanceKm = Number((totalDistanceM / 1000).toFixed(2));
  
  let fuelEfficiencyKmPerL = null;
  let fuelEfficiencyL100Km = null;
  
  if (hasFuelData && totalFuelConsumedLiters > 0) {
    fuelEfficiencyKmPerL = Number((totalDistanceKm / totalFuelConsumedLiters).toFixed(2));
    if (totalDistanceKm > 0) {
      fuelEfficiencyL100Km = Number(((totalFuelConsumedLiters / totalDistanceKm) * 100).toFixed(2));
    }
  }

  let currentFuelPercent = null;
  if (hasFuelData && fuelEnd !== null && maxFuelCapacity && maxFuelCapacity > 0) {
    currentFuelPercent = Number(((fuelEnd / maxFuelCapacity) * 100).toFixed(1));
  }

  const summary: VehicleFuelSummary = {
    fuelConsumedLiters: hasFuelData ? Number(totalFuelConsumedLiters.toFixed(2)) : null,
    fuelEfficiencyKmPerL,
    fuelEfficiencyL100Km,
    totalDistanceKm,
    fuelStartLiters: hasFuelData && fuelStart !== null ? Number(fuelStart.toFixed(2)) : null,
    fuelEndLiters: hasFuelData && fuelEnd !== null ? Number(fuelEnd.toFixed(2)) : null,
    currentFuelPercent,
    avgFuelLevelLiters: hasFuelData ? Number((fuelLevelSum / fuelLevelCount).toFixed(2)) : null,
    minFuelLevelLiters: hasFuelData ? Number(minFuel.toFixed(2)) : null,
    maxFuelLevelLiters: hasFuelData ? Number(maxFuel.toFixed(2)) : null,
    avgDailyConsumptionLiters: hasFuelData ? Number((totalFuelConsumedLiters / totalPeriodDays).toFixed(2)) : null,
    estimatedRangeKm: hasFuelData && fuelEfficiencyKmPerL !== null && fuelEnd !== null ? Number((fuelEnd * fuelEfficiencyKmPerL).toFixed(2)) : null,
    refuelEvents: events.filter(e => e.eventType === 'REFUEL').length,
    drainEvents: events.filter(e => e.eventType === 'DRAIN').length,
    theftSuspectedEvents: events.filter(e => e.eventType === 'THEFT_SUSPECTED').length,
    telemetryPoints: records.length,
  };

  return { summary, fuelTimeSeries, events };
}

export function aggregateFleetFuelSummary(vehicles: VehicleFuelResult[]): FleetFuelSummary {
  const withFuelData = vehicles.filter(v => v.summary.fuelConsumedLiters !== null);
  
  let totalFuelConsumed = 0;
  let totalDistanceKm = 0;
  let totalRefuels = 0;
  let totalDrains = 0;
  let totalThefts = 0;
  let totalCurrentFuel = 0;
  
  let lowFuelCount = 0;
  let criticalFuelCount = 0;
  
  const fuelDist: FuelDistribution = {
    critical_0_20: 0,
    low_20_40: 0,
    medium_40_60: 0,
    good_60_80: 0,
    full_80_100: 0,
  };

  for (const v of withFuelData) {
    const s = v.summary;
    totalFuelConsumed += s.fuelConsumedLiters || 0;
    totalDistanceKm += s.totalDistanceKm;
    totalRefuels += s.refuelEvents;
    totalDrains += s.drainEvents;
    totalThefts += s.theftSuspectedEvents;
    
    if (s.fuelEndLiters !== null) {
      totalCurrentFuel += s.fuelEndLiters;
    }

    if (s.currentFuelPercent !== null) {
      if (s.currentFuelPercent <= CRITICAL_FUEL_PERCENTAGE) criticalFuelCount++;
      else if (s.currentFuelPercent <= LOW_FUEL_PERCENTAGE) lowFuelCount++;

      const p = s.currentFuelPercent;
      if (p <= 20) fuelDist.critical_0_20++;
      else if (p <= 40) fuelDist.low_20_40++;
      else if (p <= 60) fuelDist.medium_40_60++;
      else if (p <= 80) fuelDist.good_60_80++;
      else fuelDist.full_80_100++;
    }
  }

  let fleetFuelEfficiencyKmPerL = 0;
  let fleetFuelEfficiencyL100Km = 0;
  if (totalFuelConsumed > 0 && totalDistanceKm > 0) {
    fleetFuelEfficiencyKmPerL = Number((totalDistanceKm / totalFuelConsumed).toFixed(2));
    fleetFuelEfficiencyL100Km = Number(((totalFuelConsumed / totalDistanceKm) * 100).toFixed(2));
  }

  let avgFuelConsumedPerVehicle = 0;
  let fleetAvgCurrentFuel = 0;
  let fleetAvgCurrentFuelPercent = 0;

  if (withFuelData.length > 0) {
    avgFuelConsumedPerVehicle = Number((totalFuelConsumed / withFuelData.length).toFixed(2));
    fleetAvgCurrentFuel = Number((totalCurrentFuel / withFuelData.length).toFixed(2));
    
    const validPercents = withFuelData.filter(v => v.summary.currentFuelPercent !== null);
    if (validPercents.length > 0) {
      const sumPercents = validPercents.reduce((sum, v) => sum + (v.summary.currentFuelPercent || 0), 0);
      fleetAvgCurrentFuelPercent = Number((sumPercents / validPercents.length).toFixed(1));
    }
  }

  return {
    totalVehicles: vehicles.length,
    vehiclesWithFuelData: withFuelData.length,
    vehiclesWithoutFuelData: vehicles.length - withFuelData.length,
    totalFuelConsumedLiters: Number(totalFuelConsumed.toFixed(2)),
    avgFuelConsumedPerVehicleLiters: avgFuelConsumedPerVehicle,
    fleetFuelEfficiencyKmPerL,
    fleetFuelEfficiencyL100Km,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    fleetAvgCurrentFuelLiters: fleetAvgCurrentFuel,
    fleetAvgCurrentFuelPercent,
    lowFuelVehicleCount: lowFuelCount,
    criticalFuelVehicleCount: criticalFuelCount,
    totalRefuelEvents: totalRefuels,
    totalDrainEvents: totalDrains,
    totalTheftSuspectedEvents: totalThefts,
    fuelDistribution: fuelDist,
  };
}

function emptySummary(): VehicleFuelSummary {
  return {
    fuelConsumedLiters: null,
    fuelEfficiencyKmPerL: null,
    fuelEfficiencyL100Km: null,
    totalDistanceKm: 0,
    fuelStartLiters: null,
    fuelEndLiters: null,
    currentFuelPercent: null,
    avgFuelLevelLiters: null,
    minFuelLevelLiters: null,
    maxFuelLevelLiters: null,
    avgDailyConsumptionLiters: null,
    estimatedRangeKm: null,
    refuelEvents: 0,
    drainEvents: 0,
    theftSuspectedEvents: 0,
    telemetryPoints: 0,
  };
}
