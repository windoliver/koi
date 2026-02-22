/**
 * Backpressure monitor: per-connection buffer tracking with watermarks.
 *
 * Tracks buffered bytes per connection and globally. Transitions through
 * normal → warning → critical states based on configured watermarks.
 */

import type { BackpressureState, GatewayConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface BackpressureMonitor {
  /** Record bytes buffered for a connection. Returns the new state. */
  readonly record: (connId: string, bytes: number) => BackpressureState;
  /** Record bytes drained for a connection. Returns the new state. */
  readonly drain: (connId: string, bytes: number) => BackpressureState;
  /** Current state for a connection. */
  readonly state: (connId: string) => BackpressureState;
  /** Remove tracking for a closed connection. */
  readonly remove: (connId: string) => void;
  /** Current global buffer usage in bytes. */
  readonly globalUsage: () => number;
  /** Whether a new connection can be accepted (global limit not exceeded). */
  readonly canAccept: () => boolean;
  /** Timestamp when connection entered critical state (undefined if not critical). */
  readonly criticalSince: (connId: string) => number | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface ConnState {
  buffered: number;
  criticalAt: number | undefined;
}

export function createBackpressureMonitor(
  config: Pick<
    GatewayConfig,
    "maxBufferPerConnection" | "backpressureHighWatermark" | "globalBufferLimitBytes"
  >,
): BackpressureMonitor {
  const conns = new Map<string, ConnState>();
  let globalBytes = 0;

  const maxBytesPerConn = config.maxBufferPerConnection;
  const warningThreshold = Math.floor(maxBytesPerConn * config.backpressureHighWatermark);

  function getOrCreate(connId: string): ConnState {
    let s = conns.get(connId);
    if (s === undefined) {
      s = { buffered: 0, criticalAt: undefined };
      conns.set(connId, s);
    }
    return s;
  }

  function computeState(s: ConnState): BackpressureState {
    if (s.buffered >= maxBytesPerConn) return "critical";
    if (s.buffered >= warningThreshold) return "warning";
    return "normal";
  }

  function updateCriticalTimestamp(s: ConnState, state: BackpressureState): void {
    if (state === "critical" && s.criticalAt === undefined) {
      s.criticalAt = Date.now();
    } else if (state !== "critical") {
      s.criticalAt = undefined;
    }
  }

  return {
    record(connId: string, bytes: number): BackpressureState {
      const s = getOrCreate(connId);
      s.buffered += bytes;
      globalBytes += bytes;
      const st = computeState(s);
      updateCriticalTimestamp(s, st);
      return st;
    },

    drain(connId: string, bytes: number): BackpressureState {
      const s = conns.get(connId);
      if (s === undefined) return "normal";
      const drained = Math.min(bytes, s.buffered);
      s.buffered -= drained;
      globalBytes = Math.max(0, globalBytes - drained);
      const st = computeState(s);
      updateCriticalTimestamp(s, st);
      return st;
    },

    state(connId: string): BackpressureState {
      const s = conns.get(connId);
      if (s === undefined) return "normal";
      return computeState(s);
    },

    remove(connId: string): void {
      const s = conns.get(connId);
      if (s !== undefined) {
        globalBytes = Math.max(0, globalBytes - s.buffered);
        conns.delete(connId);
      }
    },

    globalUsage(): number {
      return globalBytes;
    },

    canAccept(): boolean {
      return globalBytes < config.globalBufferLimitBytes;
    },

    criticalSince(connId: string): number | undefined {
      return conns.get(connId)?.criticalAt;
    },
  };
}
