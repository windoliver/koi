/**
 * Backpressure monitor: per-connection buffer tracking with watermarks.
 */

import type { BackpressureState, GatewayConfig } from "./types.js";

export interface BackpressureMonitor {
  readonly record: (connId: string, bytes: number) => BackpressureState;
  readonly drain: (connId: string, bytes: number) => BackpressureState;
  readonly state: (connId: string) => BackpressureState;
  readonly remove: (connId: string) => void;
  readonly globalUsage: () => number;
  readonly canAccept: () => boolean;
  readonly criticalSince: (connId: string) => number | undefined;
}

interface ConnState {
  readonly buffered: number;
  readonly criticalAt: number | undefined;
}

export function createBackpressureMonitor(
  config: Pick<
    GatewayConfig,
    "maxBufferBytesPerConnection" | "backpressureHighWatermark" | "globalBufferLimitBytes"
  >,
): BackpressureMonitor {
  const conns = new Map<string, ConnState>();
  let globalBytes = 0;

  const maxBytesPerConn = config.maxBufferBytesPerConnection;
  const warningThreshold = Math.floor(maxBytesPerConn * config.backpressureHighWatermark);

  function getOrCreate(connId: string): ConnState {
    const existing = conns.get(connId);
    if (existing !== undefined) return existing;
    const fresh: ConnState = { buffered: 0, criticalAt: undefined };
    conns.set(connId, fresh);
    return fresh;
  }

  function computeState(s: ConnState): BackpressureState {
    if (s.buffered >= maxBytesPerConn) return "critical";
    if (s.buffered >= warningThreshold) return "warning";
    return "normal";
  }

  function withCriticalTimestamp(s: ConnState, state: BackpressureState): ConnState {
    const criticalAt =
      state === "critical" && s.criticalAt === undefined
        ? Date.now()
        : state !== "critical"
          ? undefined
          : s.criticalAt;
    return criticalAt === s.criticalAt ? s : { buffered: s.buffered, criticalAt };
  }

  return {
    record(connId: string, bytes: number): BackpressureState {
      const prev = getOrCreate(connId);
      const updated: ConnState = { buffered: prev.buffered + bytes, criticalAt: prev.criticalAt };
      globalBytes += bytes;
      const st = computeState(updated);
      conns.set(connId, withCriticalTimestamp(updated, st));
      return st;
    },

    drain(connId: string, bytes: number): BackpressureState {
      const prev = conns.get(connId);
      if (prev === undefined) return "normal";
      const drained = Math.min(bytes, prev.buffered);
      const updated: ConnState = { buffered: prev.buffered - drained, criticalAt: prev.criticalAt };
      globalBytes = Math.max(0, globalBytes - drained);
      const st = computeState(updated);
      conns.set(connId, withCriticalTimestamp(updated, st));
      return st;
    },

    state(connId: string): BackpressureState {
      const s = conns.get(connId);
      return s === undefined ? "normal" : computeState(s);
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
