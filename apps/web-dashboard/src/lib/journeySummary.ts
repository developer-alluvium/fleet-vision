import { getDistance, Point } from './douglasPeucker';

export interface JourneySummary {
  totalDistanceKm: number;
  drivingDurationMinutes: number;
  idleDurationMinutes: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  startTime: string | null;
  endTime: string | null;
  startOdometer: number | null;
  endOdometer: number | null;
}

export function calculateJourneySummary(points: Point[]): JourneySummary {
  if (!points || points.length === 0) {
    return {
      totalDistanceKm: 0,
      drivingDurationMinutes: 0,
      idleDurationMinutes: 0,
      maxSpeedKmh: 0,
      avgSpeedKmh: 0,
      startTime: null,
      endTime: null,
      startOdometer: null,
      endOdometer: null,
    };
  }

  let totalDistanceMeters = 0;
  let drivingDurationMs = 0;
  let idleDurationMs = 0;
  let maxSpeedKmh = 0;

  let prevPoint = points[0];

  for (let i = 1; i < points.length; i++) {
    const currentPoint = points[i];

    // Distance
    const distanceMeters = getDistance(prevPoint, currentPoint);
    totalDistanceMeters += distanceMeters;

    // Time difference in ms
    const timeDiffMs = new Date(currentPoint.time).getTime() - new Date(prevPoint.time).getTime();
    
    // Ignore gaps larger than a threshold (e.g. 4 hours) as they might be device offline periods
    // For idle, we check if ignition is ON but speed is very low.
    if (timeDiffMs > 0 && timeDiffMs < 4 * 60 * 60 * 1000) {
      const avgSpeedSegment = ((prevPoint.speed || 0) + (currentPoint.speed || 0)) / 2;
      
      const isDriving = avgSpeedSegment > 2;
      const isIdle = !isDriving && prevPoint.ignition;

      if (isDriving) {
        drivingDurationMs += timeDiffMs;
      } else if (isIdle) {
        idleDurationMs += timeDiffMs;
      }
    }

    if ((currentPoint.speed || 0) > maxSpeedKmh) {
      maxSpeedKmh = currentPoint.speed;
    }

    prevPoint = currentPoint;
  }

  // Handle first point speed
  if ((points[0].speed || 0) > maxSpeedKmh) {
    maxSpeedKmh = points[0].speed;
  }

  const drivingDurationHours = drivingDurationMs / (1000 * 60 * 60);
  const totalDistanceKm = totalDistanceMeters / 1000;
  
  let avgSpeedKmh = 0;
  if (drivingDurationHours > 0) {
    avgSpeedKmh = totalDistanceKm / drivingDurationHours;
  }

  return {
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    drivingDurationMinutes: Math.round(drivingDurationMs / 60000),
    idleDurationMinutes: Math.round(idleDurationMs / 60000),
    maxSpeedKmh: Math.round(maxSpeedKmh),
    avgSpeedKmh: Number(avgSpeedKmh.toFixed(1)),
    startTime: new Date(points[0].time).toISOString(),
    endTime: new Date(points[points.length - 1].time).toISOString(),
    startOdometer: points[0].odometer ?? null,
    endOdometer: points[points.length - 1].odometer ?? null,
  };
}
