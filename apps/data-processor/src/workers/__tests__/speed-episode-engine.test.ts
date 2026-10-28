import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processSpeedPing, SpeedEpisodeConfig, SpeedEpisodeState, createInitialState } from "../speed-episode-engine";

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

describe("Speed Episode Engine", () => {
  const config: SpeedEpisodeConfig = {
    speedLimitKmh: 40,
    minPings: 2,
    minDurationSec: 10,
    hysteresisKmh: 3,
    endPings: 2,
    renotifyIntervalMin: 5,
    severityThresholds: { minor: 1.2, major: 1.5 }
  };

  it("12 consecutive pings at 50 km/h with a 40 limit -> exactly 1 episode, 1 ViolationStarted", () => {
    let state: SpeedEpisodeState | null = null;
    let startedEvents = 0;
    
    // Simulate 12 pings, 10 seconds apart
    let baseTime = Date.now() - 200000;
    for (let i = 0; i < 12; i++) {
      const pingTime = new Date(baseTime + i * 10000).toISOString();
      const result = processSpeedPing(state, { speed: 50, lat: 0, lng: 0, timestamp: pingTime }, config);
      state = result.newState;
      startedEvents += result.events.filter(e => e.type === "ViolationStarted").length;
    }

    expect(state?.status).toBe("SPEEDING");
    expect(startedEvents).toBe(1);
    expect(state?.pingCount).toBe(12);
  });

  it("Single-ping spike -> no episode (debounce)", () => {
    let state = createInitialState();
    
    // One ping above limit
    const res1 = processSpeedPing(state, { speed: 50, lat: 0, lng: 0, timestamp: new Date().toISOString() }, config);
    expect(res1.newState.status).toBe("NORMAL");
    expect(res1.events.some(e => e.type === "ViolationStarted")).toBe(false);

    // Next ping normal
    const res2 = processSpeedPing(res1.newState, { speed: 30, lat: 0, lng: 0, timestamp: new Date(Date.now() + 10000).toISOString() }, config);
    expect(res2.newState.status).toBe("NORMAL");
    expect(res2.newState.overCount).toBe(0);
  });

  it("Speed hovering 39-41 -> no flapping (hysteresis)", () => {
    let state = createInitialState();
    let baseTime = Date.now() - 200000;
    
    // Trigger episode
    state = processSpeedPing(state, { speed: 45, lat: 0, lng: 0, timestamp: new Date(baseTime).toISOString() }, config).newState;
    state = processSpeedPing(state, { speed: 45, lat: 0, lng: 0, timestamp: new Date(baseTime + 10000).toISOString() }, config).newState;
    expect(state.status).toBe("SPEEDING");

    // Hover near limit (39 is not < 40 - 3)
    let res = processSpeedPing(state, { speed: 39, lat: 0, lng: 0, timestamp: new Date(baseTime + 20000).toISOString() }, config);
    expect(res.newState.status).toBe("SPEEDING");
    expect(res.newState.underCount).toBe(0); // 39 is not below limit - hysteresis (37)
    
    res = processSpeedPing(res.newState, { speed: 41, lat: 0, lng: 0, timestamp: new Date(baseTime + 30000).toISOString() }, config);
    expect(res.newState.status).toBe("SPEEDING");

    // Drop below hysteresis
    res = processSpeedPing(res.newState, { speed: 36, lat: 0, lng: 0, timestamp: new Date(baseTime + 40000).toISOString() }, config);
    expect(res.newState.underCount).toBe(1);
    
    res = processSpeedPing(res.newState, { speed: 36, lat: 0, lng: 0, timestamp: new Date(baseTime + 50000).toISOString() }, config);
    expect(res.newState.status).toBe("NORMAL");
    expect(res.events.some(e => e.type === "ViolationEnded")).toBe(true);
  });

  it("Escalation MINOR -> CRITICAL emits exactly one ViolationEscalated per level", () => {
    let state = createInitialState();
    let baseTime = Date.now() - 200000;
    
    // Minor: 40 * 1.2 = 48. Speed = 45 -> Minor
    let res = processSpeedPing(state, { speed: 45, lat: 0, lng: 0, timestamp: new Date(baseTime).toISOString() }, config);
    res = processSpeedPing(res.newState, { speed: 45, lat: 0, lng: 0, timestamp: new Date(baseTime + 10000).toISOString() }, config);
    expect(res.newState.severity).toBe("MINOR");

    // Major: 40 * 1.5 = 60. Speed = 50 -> Major
    res = processSpeedPing(res.newState, { speed: 50, lat: 0, lng: 0, timestamp: new Date(baseTime + 20000).toISOString() }, config);
    expect(res.events.some(e => e.type === "ViolationEscalated" && (e as any).to === "MAJOR")).toBe(true);
    expect(res.newState.severity).toBe("MAJOR");

    // Critical: Speed = 65 -> Critical
    res = processSpeedPing(res.newState, { speed: 65, lat: 0, lng: 0, timestamp: new Date(baseTime + 30000).toISOString() }, config);
    expect(res.events.some(e => e.type === "ViolationEscalated" && (e as any).to === "CRITICAL")).toBe(true);
    expect(res.newState.severity).toBe("CRITICAL");
  });

  it("Out-of-order and stale pings are ignored or suppressed", () => {
    let state = createInitialState();
    const now = Date.now();
    
    let res = processSpeedPing(state, { speed: 50, lat: 0, lng: 0, timestamp: new Date(now).toISOString() }, config);
    
    // Out of order ping (older)
    const outOfOrderRes = processSpeedPing(res.newState, { speed: 60, lat: 0, lng: 0, timestamp: new Date(now - 1000).toISOString() }, config);
    expect(outOfOrderRes.events.length).toBe(0); // ignored
    
    // Stale ping (more than 5 mins old)
    const staleRes = processSpeedPing(state, { speed: 50, lat: 0, lng: 0, timestamp: new Date(now - 6 * 60 * 1000).toISOString() }, config);
    expect(staleRes.suppressNotification).toBe(true);
  });
});
