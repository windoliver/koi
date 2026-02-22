/**
 * Scheduler: timer-based periodic frame generation.
 * Each SchedulerDef produces GatewayFrames at a fixed interval.
 */

import type { GatewayFrame, SchedulerDef, Session } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchedulerDispatcher = (session: Session, frame: GatewayFrame) => void;

export interface GatewayScheduler {
  readonly start: () => void;
  readonly stop: () => void;
  readonly count: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum allowed scheduler interval to prevent accidental self-DoS. */
const MIN_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScheduler(
  defs: readonly SchedulerDef[],
  dispatcher: SchedulerDispatcher,
): GatewayScheduler {
  const timers: Timer[] = [];
  let frameCounter = 0;

  function nextFrameId(): string {
    return `sched-${crypto.randomUUID().slice(0, 8)}-${frameCounter++}`;
  }

  // Validate all defs up front
  for (const def of defs) {
    if (def.intervalMs < MIN_INTERVAL_MS) {
      throw new Error(
        `Scheduler "${def.id}" intervalMs (${def.intervalMs}) is below minimum (${MIN_INTERVAL_MS}ms)`,
      );
    }
  }

  return {
    start(): void {
      // Guard against double-start: clear existing timers first
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;

      for (const def of defs) {
        const connectedAt = Date.now();

        const timer = setInterval(() => {
          const frameId = nextFrameId();

          const session: Session = {
            id: `scheduler-${def.id}`,
            agentId: def.agentId,
            connectedAt,
            lastHeartbeat: Date.now(),
            seq: 0,
            remoteSeq: 0,
            metadata: { schedulerId: def.id },
          };

          const frame: GatewayFrame = {
            kind: "event",
            id: frameId,
            seq: 0,
            timestamp: Date.now(),
            payload: def.payload ?? { schedulerId: def.id, type: "tick" },
          };

          dispatcher(session, frame);
        }, def.intervalMs);

        timers.push(timer);
      }
    },

    stop(): void {
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
    },

    count(): number {
      return timers.length;
    },
  };
}
