import * as crypto from "crypto";

export type SpeedEpisodeState = {
  status: "NORMAL" | "SPEEDING";
  overCount: number;
  underCount: number;
  episodeId: string | null;
  episodeStartTs: string | null;
  peakSpeed: number;
  peakLat: number;
  peakLng: number;
  severity: "MINOR" | "MAJOR" | "CRITICAL";
  lastNotifiedTs: string | null;
  lastEventTs: string | null;
  pingCount: number;
  speedSum: number;
};

export type SpeedEpisodeConfig = {
  speedLimitKmh: number;
  minPings: number;
  minDurationSec: number;
  hysteresisKmh: number;
  endPings: number;
  renotifyIntervalMin: number;
  severityThresholds: {
    minor: number;
    major: number;
  };
};

export type EpisodeEvent =
  | { type: "ViolationStarted"; episodeId: string }
  | { type: "ViolationEscalated"; from: string; to: string }
  | { type: "ViolationReminder" }
  | {
      type: "ViolationEnded";
      durationSec: number;
      peakSpeed: number;
      avgSpeed: number;
      closeReason: string;
    }
  | { type: "StateUpdated" };

export function createInitialState(): SpeedEpisodeState {
  return {
    status: "NORMAL",
    overCount: 0,
    underCount: 0,
    episodeId: null,
    episodeStartTs: null,
    peakSpeed: 0,
    peakLat: 0,
    peakLng: 0,
    severity: "MINOR",
    lastNotifiedTs: null,
    lastEventTs: null,
    pingCount: 0,
    speedSum: 0,
  };
}

export function determineSeverity(
  speed: number,
  limit: number,
  thresholds: SpeedEpisodeConfig["severityThresholds"]
): "MINOR" | "MAJOR" | "CRITICAL" {
  if (speed > limit * thresholds.major) return "CRITICAL";
  if (speed > limit * thresholds.minor) return "MAJOR";
  return "MINOR";
}

/**
 * Pure function state machine for geofence speed episodes.
 */
export function processSpeedPing(
  currentState: SpeedEpisodeState | null,
  ping: { speed: number; lat: number; lng: number; timestamp: string },
  config: SpeedEpisodeConfig
): { newState: SpeedEpisodeState; events: EpisodeEvent[]; suppressNotification: boolean } {
  const state = currentState ? { ...currentState } : createInitialState();
  const events: EpisodeEvent[] = [];
  const pingTs = new Date(ping.timestamp).getTime();
  const now = Date.now();

  let suppressNotification = false;

  // Ignore older pings to prevent out-of-order state corruption
  if (state.lastEventTs) {
    const lastTs = new Date(state.lastEventTs).getTime();
    if (pingTs <= lastTs) {
      return { newState: state, events: [], suppressNotification };
    }
  }

  // If the event is older than 5 minutes vs server time, flag it
  if (now - pingTs > 5 * 60 * 1000) {
    suppressNotification = true;
  }

  state.lastEventTs = ping.timestamp;

  if (state.status === "NORMAL") {
    if (ping.speed > config.speedLimitKmh) {
      state.overCount++;
      state.underCount = 0;

      // Track potential episode start if this is the first ping over
      if (state.overCount === 1) {
        state.episodeStartTs = ping.timestamp;
      }

      // Check transition conditions
      const durationSec = state.episodeStartTs
        ? (pingTs - new Date(state.episodeStartTs).getTime()) / 1000
        : 0;

      if (state.overCount >= config.minPings || durationSec >= config.minDurationSec) {
        // Transition to SPEEDING
        state.status = "SPEEDING";
        state.episodeId = crypto.randomUUID();
        // episodeStartTs is already set
        state.peakSpeed = ping.speed;
        state.peakLat = ping.lat;
        state.peakLng = ping.lng;
        state.severity = determineSeverity(ping.speed, config.speedLimitKmh, config.severityThresholds);
        state.lastNotifiedTs = ping.timestamp;
        state.pingCount = state.overCount;
        state.speedSum = ping.speed * state.overCount; // rough approximation

        events.push({ type: "ViolationStarted", episodeId: state.episodeId });
      } else {
        events.push({ type: "StateUpdated" });
      }
    } else {
      // Reset counters if speed drops back below limit before transition
      if (state.overCount > 0) {
        state.overCount = 0;
        state.episodeStartTs = null;
        events.push({ type: "StateUpdated" });
      }
    }
  } else if (state.status === "SPEEDING") {
    // Update episode aggregates
    state.pingCount++;
    state.speedSum += ping.speed;

    if (ping.speed > state.peakSpeed) {
      state.peakSpeed = ping.speed;
      state.peakLat = ping.lat;
      state.peakLng = ping.lng;
    }

    if (ping.speed < config.speedLimitKmh - config.hysteresisKmh) {
      state.underCount++;
      state.overCount = 0;

      if (state.underCount >= config.endPings) {
        // Transition back to NORMAL
        const durationSec = state.episodeStartTs
          ? (pingTs - new Date(state.episodeStartTs).getTime()) / 1000
          : 0;
        const avgSpeed = state.pingCount > 0 ? state.speedSum / state.pingCount : 0;

        events.push({
          type: "ViolationEnded",
          durationSec: Math.round(durationSec),
          peakSpeed: state.peakSpeed,
          avgSpeed,
          closeReason: "RESOLVED",
        });

        // Reset state back to normal
        const lastEventTs = state.lastEventTs;
        Object.assign(state, createInitialState());
        state.lastEventTs = lastEventTs;
      } else {
        events.push({ type: "StateUpdated" });
      }
    } else {
      // Still speeding
      state.underCount = 0;
      state.overCount++;

      // Check escalation
      const currentSeverity = determineSeverity(ping.speed, config.speedLimitKmh, config.severityThresholds);
      
      const severityOrder = { MINOR: 1, MAJOR: 2, CRITICAL: 3 };
      if (severityOrder[currentSeverity] > severityOrder[state.severity]) {
        const oldSeverity = state.severity;
        state.severity = currentSeverity;
        events.push({
          type: "ViolationEscalated",
          from: oldSeverity,
          to: currentSeverity,
        });
      }

      // Check reminder
      if (state.lastNotifiedTs) {
        const lastNotifiedMs = new Date(state.lastNotifiedTs).getTime();
        const minMs = config.renotifyIntervalMin * 60 * 1000;
        if (pingTs - lastNotifiedMs >= minMs) {
          state.lastNotifiedTs = ping.timestamp;
          events.push({ type: "ViolationReminder" });
        }
      }

      // Ensure we always push at least StateUpdated if nothing else happened
      if (events.length === 0) {
        events.push({ type: "StateUpdated" });
      }
    }
  }

  return { newState: state, events, suppressNotification };
}
