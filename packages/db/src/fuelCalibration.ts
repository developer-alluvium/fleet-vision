export interface CalibrationPoint {
  rawValue: number;
  liters: number;
}

/**
 * Piecewise linear interpolation: given a sorted calibration table
 * and a raw sensor reading, returns the fuel level in liters.
 *
 * - If rawValue is below the lowest point → returns lowest liters (clamped)
 * - If rawValue is above the highest point → returns highest liters (clamped)
 * - Otherwise → linearly interpolates between the two surrounding points
 */
export function rawToLiters(
  rawValue: number,
  table: CalibrationPoint[]
): number | null {
  if (!table || table.length === 0) return null;
  if (table.length === 1) return table[0].liters;

  // Table must be sorted by rawValue ASC
  const sorted = [...table].sort((a, b) => a.rawValue - b.rawValue);

  // Clamp to bounds
  if (rawValue <= sorted[0].rawValue) return sorted[0].liters;
  if (rawValue >= sorted[sorted.length - 1].rawValue) return sorted[sorted.length - 1].liters;

  // Find the two surrounding points and interpolate
  for (let i = 0; i < sorted.length - 1; i++) {
    if (rawValue >= sorted[i].rawValue && rawValue <= sorted[i + 1].rawValue) {
      const ratio =
        (rawValue - sorted[i].rawValue) /
        (sorted[i + 1].rawValue - sorted[i].rawValue);
      return Number((sorted[i].liters + ratio * (sorted[i + 1].liters - sorted[i].liters)).toFixed(2));
    }
  }

  return null;
}
