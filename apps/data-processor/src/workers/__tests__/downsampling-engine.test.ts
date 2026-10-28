import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { redis } from "@fleet-vision/db";
import {
  getDistanceMeters,
  getAngleDelta,
  shouldSaveToTimescale,
  resetDownsamplingStats,
  clearDeviceState,
  getDownsamplingStats,
} from "../downsampling-engine";

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      assert.strictEqual(actual, expected);
    },
    toBeGreaterThan(expected: number) {
      assert.ok(
        (actual as unknown as number) > expected,
        `Expected ${actual} to be greater than ${expected}`
      );
    },
    toBeLessThan(expected: number) {
      assert.ok(
        (actual as unknown as number) < expected,
        `Expected ${actual} to be less than ${expected}`
      );
    },
  };
}

describe("Golden Triangle Downsampling Engine", () => {
  const TEST_IMEI = "868204050099999";

  beforeEach(() => {
    resetDownsamplingStats();
    clearDeviceState(TEST_IMEI);
  });

  after(() => {
    redis.disconnect();
  });

  describe("Math Utilities", () => {
    it("Calculates Haversine distance correctly", () => {
      // Coordinate delta ~111 meters North (approx 0.001 deg lat)
      const dist = getDistanceMeters(19.076, 72.8777, 19.077, 72.8777);
      expect(dist).toBeGreaterThan(105);
      expect(dist).toBeLessThan(115);

      // Same point distance is 0
      expect(getDistanceMeters(19.076, 72.8777, 19.076, 72.8777)).toBe(0);
    });

    it("Calculates shortest angular delta across 360-degree boundary", () => {
      // Simple 30 deg turn
      expect(getAngleDelta(45, 75)).toBe(30);

      // Across 0° / 360° boundary: 350° to 10° is 20°, NOT 340°
      expect(getAngleDelta(350, 10)).toBe(20);
      expect(getAngleDelta(5, 355)).toBe(10);

      // Opposite direction is 180°
      expect(getAngleDelta(0, 180)).toBe(180);
    });
  });

  describe("Decision Engine & Golden Triangle Rules", () => {
    const baseTime = 1700000000000;

    it("Rule 1: Always saves first record seen for an IMEI", () => {
      const decision = shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 40,
        ignition: true,
      });

      expect(decision.shouldSave).toBe(true);
      expect(decision.reason).toBe("FIRST_RECORD");
    });

    it("Rule 2: Always saves ignition change events (Trip Start & Stop)", () => {
      // Initial parked record
      shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 0,
        ignition: false,
      });

      // 2 seconds later: Key turned ON (Trip Start)
      const tripStart = shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime + 2000),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 0,
        ignition: true,
      });

      expect(tripStart.shouldSave).toBe(true);
      expect(tripStart.reason).toBe("IGNITION_CHANGED");
    });

    it("Suppresses redundant 1-2s straight-line driving points", () => {
      // 1. Initial point
      shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 30,
        ignition: true,
      });

      // 2. 2 seconds later: moved only 15 meters straight (heading 90)
      // Lat 19.076, Lon 72.87784 (approx 15m)
      const ping2s = shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime + 2000),
        latitude: 19.076,
        longitude: 72.87784,
        angle: 90,
        speed: 30,
        ignition: true,
      });

      // SHOULD BE SKIPPED FROM TIMESCALEDB!
      expect(ping2s.shouldSave).toBe(false);
      expect(ping2s.reason).toBe("SKIPPED_REDUNDANT");

      // 3. 4 seconds later: moved another 15m straight (total 30m, < 50m)
      const ping4s = shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime + 4000),
        latitude: 19.076,
        longitude: 72.87798,
        angle: 90,
        speed: 30,
        ignition: true,
      });
      expect(ping4s.shouldSave).toBe(false);
    });

    it("Angle Trigger: Saves immediately when vehicle turns >= 30°", () => {
      // Initial point heading East (90°)
      shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 25,
        ignition: true,
      });

      // 2 seconds later: turns right heading South-East (125°) -> Delta 35°
      const turnPing = shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime + 2000),
        latitude: 19.076,
        longitude: 72.87785,
        angle: 125, // 35° turn
        speed: 20,
        ignition: true,
      });

      expect(turnPing.shouldSave).toBe(true);
      expect(turnPing.reason).toBe("ANGLE_DELTA");
    });

    it("Distance Trigger: Saves when vehicle moves >= 50 meters", () => {
      // Initial point
      shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 80,
        ignition: true,
      });

      // 2 seconds later at 80 km/h: moved 60 meters (Lat 19.076, Lon ~72.8783)
      const distancePing = shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime + 2000),
        latitude: 19.076,
        longitude: 72.8783,
        angle: 90,
        speed: 80,
        ignition: true,
      });

      expect(distancePing.shouldSave).toBe(true);
      expect(distancePing.reason).toBe("DISTANCE_DELTA");
    });

    it("Time Trigger: Saves periodic checkpoint every 15 seconds in traffic/idling", () => {
      // Initial point at traffic stop
      shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 0,
        ignition: true,
      });

      // At T+5s and T+10s: stationary, ignored
      expect(
        shouldSaveToTimescale(TEST_IMEI, {
          timestamp: new Date(baseTime + 5000),
          latitude: 19.076,
          longitude: 72.8777,
          angle: 90,
          speed: 0,
          ignition: true,
        }).shouldSave
      ).toBe(false);

      expect(
        shouldSaveToTimescale(TEST_IMEI, {
          timestamp: new Date(baseTime + 10000),
          latitude: 19.076,
          longitude: 72.8777,
          angle: 90,
          speed: 0,
          ignition: true,
        }).shouldSave
      ).toBe(false);

      // At T+15s: periodic time trigger fires
      const checkpointPing = shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime + 15000),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 90,
        speed: 0,
        ignition: true,
      });

      expect(checkpointPing.shouldSave).toBe(true);
      expect(checkpointPing.reason).toBe("TIME_INTERVAL");
    });
  });

  describe("Observability Stats", () => {
    it("Accurately measures disk write suppression percentage", () => {
      const baseTime = 1700000000000;

      // First point (saved)
      shouldSaveToTimescale(TEST_IMEI, {
        timestamp: new Date(baseTime),
        latitude: 19.076,
        longitude: 72.8777,
        angle: 0,
        speed: 10,
        ignition: true,
      });

      // 4 straight-line 2-second points (skipped)
      for (let i = 1; i <= 4; i++) {
        shouldSaveToTimescale(TEST_IMEI, {
          timestamp: new Date(baseTime + i * 2000),
          latitude: 19.076 + i * 0.00005,
          longitude: 72.8777,
          angle: 0,
          speed: 10,
          ignition: true,
        });
      }

      const stats = getDownsamplingStats();
      expect(stats.totalEvaluated).toBe(5);
      expect(stats.savedToTimescale).toBe(1);
      expect(stats.skippedDuplicates).toBe(4);
      expect(stats.suppressionRatePercent).toBe(80.0);
    });
  });
});
