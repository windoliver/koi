/**
 * Agent lifecycle state machine — pure transition function.
 *
 * States: created → running → waiting → suspended → idle → terminated
 * All transitions are pure: transition(current, event) → new state.
 * The terminated state is absorbing — no transitions out.
 */

import type { EngineMetrics, EngineStopReason } from "@koi/core";

// ---------------------------------------------------------------------------
// Lifecycle state (discriminated union)
// ---------------------------------------------------------------------------

export type AgentLifecycle =
  | { readonly state: "created"; readonly createdAt: number }
  | { readonly state: "running"; readonly startedAt: number; readonly turnIndex: number }
  | { readonly state: "waiting"; readonly reason: WaitReason; readonly since: number }
  | {
      readonly state: "suspended";
      readonly suspendedAt: number;
      readonly reason: string;
    }
  | { readonly state: "idle"; readonly idledAt: number }
  | {
      readonly state: "terminated";
      readonly stopReason: EngineStopReason;
      readonly terminatedAt: number;
      readonly metrics?: EngineMetrics;
    };

export type WaitReason = "model_call" | "model_stream" | "tool_call";

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export type LifecycleEvent =
  | { readonly kind: "start" }
  | { readonly kind: "wait"; readonly reason: WaitReason }
  | { readonly kind: "resume" }
  | { readonly kind: "suspend"; readonly reason: string }
  | { readonly kind: "idle" }
  | {
      readonly kind: "complete";
      readonly stopReason: EngineStopReason;
      readonly metrics?: EngineMetrics;
    }
  | { readonly kind: "error"; readonly error: unknown };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a terminated state, conditionally including metrics only when defined.
 * Required by exactOptionalPropertyTypes — can't assign undefined to optional field.
 */
function terminated(
  stopReason: EngineStopReason,
  terminatedAt: number,
  metrics?: EngineMetrics,
): AgentLifecycle & { readonly state: "terminated" } {
  const base = { state: "terminated" as const, stopReason, terminatedAt };
  return metrics !== undefined ? { ...base, metrics } : base;
}

// ---------------------------------------------------------------------------
// Pure transition function
// ---------------------------------------------------------------------------

export function transition(
  current: AgentLifecycle,
  event: LifecycleEvent,
  now: number = Date.now(),
): AgentLifecycle {
  // Terminated is absorbing — no transitions out
  if (current.state === "terminated") {
    return current;
  }

  switch (current.state) {
    case "created": {
      if (event.kind === "start") {
        return { state: "running", startedAt: now, turnIndex: 0 };
      }
      if (event.kind === "error") {
        return terminated("error", now);
      }
      return current;
    }

    case "running": {
      switch (event.kind) {
        case "wait":
          return { state: "waiting", reason: event.reason, since: now };
        case "suspend":
          return { state: "suspended", suspendedAt: now, reason: event.reason };
        case "idle":
          return { state: "idle", idledAt: now };
        case "complete":
          return terminated(event.stopReason, now, event.metrics);
        case "error":
          return terminated("error", now);
        default:
          return current;
      }
    }

    case "waiting": {
      switch (event.kind) {
        case "resume":
          return { state: "running", startedAt: now, turnIndex: 0 };
        case "suspend":
          return { state: "suspended", suspendedAt: now, reason: event.reason };
        case "complete":
          return terminated(event.stopReason, now, event.metrics);
        case "error":
          return terminated("error", now);
        default:
          return current;
      }
    }

    case "suspended": {
      switch (event.kind) {
        case "resume":
          return { state: "running", startedAt: now, turnIndex: 0 };
        case "complete":
          return terminated(event.stopReason, now, event.metrics);
        case "error":
          return terminated("error", now);
        default:
          return current;
      }
    }

    case "idle": {
      switch (event.kind) {
        case "resume":
          return { state: "running", startedAt: now, turnIndex: 0 };
        case "complete":
          return terminated(event.stopReason, now, event.metrics);
        case "error":
          return terminated("error", now);
        default:
          return current;
      }
    }

    default: {
      const _exhaustive: never = current;
      throw new Error(`Unhandled state: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLifecycle(now: number = Date.now()): AgentLifecycle {
  return { state: "created", createdAt: now };
}
