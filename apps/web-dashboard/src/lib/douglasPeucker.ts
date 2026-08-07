export interface Point {
  lat: number;
  lng: number;
  [key: string]: any;
}

/**
 * Calculates the Haversine distance between two points in meters.
 */
export function getDistance(p1: Point, p2: Point): number {
  const R = 6371e3; // Earth radius in meters
  const φ1 = (p1.lat * Math.PI) / 180;
  const φ2 = (p2.lat * Math.PI) / 180;
  const Δφ = ((p2.lat - p1.lat) * Math.PI) / 180;
  const Δλ = ((p2.lng - p1.lng) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Calculates the approximate perpendicular distance from a point to a line segment.
 * Uses an equirectangular approximation for performance.
 * Returns distance in meters.
 */
function getPerpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const R = 6371e3;
  const lat1 = (lineStart.lat * Math.PI) / 180;
  const lng1 = (lineStart.lng * Math.PI) / 180;
  const lat2 = (lineEnd.lat * Math.PI) / 180;
  const lng2 = (lineEnd.lng * Math.PI) / 180;
  const lat3 = (point.lat * Math.PI) / 180;
  const lng3 = (point.lng * Math.PI) / 180;

  if (lat1 === lat2 && lng1 === lng2) {
    return getDistance(point, lineStart);
  }

  // Equirectangular approximation
  const x1 = lng1 * Math.cos(lat1);
  const y1 = lat1;
  const x2 = lng2 * Math.cos(lat2);
  const y2 = lat2;
  const x3 = lng3 * Math.cos(lat3);
  const y3 = lat3;

  const px = x2 - x1;
  const py = y2 - y1;

  const norm = px * px + py * py;
  const u = ((x3 - x1) * px + (y3 - y1) * py) / norm;

  if (u > 1) {
    // Closest point is beyond lineEnd
    return getDistance(point, lineEnd);
  } else if (u < 0) {
    // Closest point is before lineStart
    return getDistance(point, lineStart);
  }

  // Closest point is on the segment
  const x = x1 + u * px;
  const y = y1 + u * py;

  const dx = x3 - x;
  const dy = y3 - y;

  return Math.sqrt(dx * dx + dy * dy) * R;
}

/**
 * Simplifies a given array of geographic points using the Douglas-Peucker algorithm.
 * Iterative version to prevent Maximum Call Stack Size Exceeded errors.
 * @param points Array of objects containing at least lat and lng properties.
 * @param epsilon The distance tolerance in meters. Points closer to the simplified line than epsilon will be discarded.
 * @returns A new array containing the simplified points.
 */
export function simplifyRoute<T extends Point>(points: T[], epsilon: number): T[] {
  if (points.length <= 2) {
    return points;
  }

  const bitset = new Uint8Array(points.length);
  bitset[0] = 1;
  bitset[points.length - 1] = 1;

  const stack: [number, number][] = [];
  stack.push([0, points.length - 1]);

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDistance = 0;
    let index = 0;

    for (let i = start + 1; i < end; i++) {
      const d = getPerpendicularDistance(points[i], points[start], points[end]);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }

    if (maxDistance > epsilon) {
      bitset[index] = 1;
      // Push subsegments. Order doesn't matter for correctness.
      stack.push([start, index]);
      stack.push([index, end]);
    }
  }

  const simplified: T[] = [];
  for (let i = 0; i < points.length; i++) {
    if (bitset[i]) {
      simplified.push(points[i]);
    }
  }

  return simplified;
}

/**
 * Automatically chooses an appropriate epsilon based on the number of points and simplifies the route.
 * @param points The full array of telemetry points.
 * @returns The simplified route, epsilon used, and whether simplification was applied.
 */
export function adaptiveSimplifyRoute<T extends Point>(points: T[]): { route: T[]; epsilon: number; simplified: boolean } {
  const len = points.length;
  
  // Don't simplify small datasets
  if (len <= 5000) {
    return { route: points, epsilon: 0, simplified: false };
  }
  
  // Choose epsilon (in meters) based on point count to aggressively reduce size
  let epsilon = 10;
  if (len > 500000) epsilon = 250;
  else if (len > 100000) epsilon = 100;
  else if (len > 50000) epsilon = 50;
  else if (len > 20000) epsilon = 25;

  const simplifiedRoute = simplifyRoute(points, epsilon);
  
  return { route: simplifiedRoute, epsilon, simplified: true };
}
